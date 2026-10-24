"""Only synthetic figures; no original book pixels or user OCR text in tests."""
import base64
from contextlib import redirect_stdout
from io import BytesIO,StringIO
from pathlib import Path
import random
import sys
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from PIL import Image,ImageDraw

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import ebook_private_b15_figure_pixel_registration as pixel
import ebook_b15_feature_crosscheck as feature
import ebook_b15_ocr_quad_spatial_candidates as spatial
import ebook_b15_private_legend_contact_sheet as atlas
import ebook_b15_four_legend_source_cells as cells
from test_ebook_b15_ocr_quad_spatial_candidates import fixture as earlier_fixture


def synthetic_legend(w=420,h=400):
    # Not copied from any actual book; two rows and two columns, generic glyphs.
    picture=Image.new("L",(w,h),253)
    draw=ImageDraw.Draw(picture)
    top=int(h*.87)
    draw.rectangle((int(w*.19),top,int(w*.83),h-3),outline=4,width=2)
    left,right=int(w*.19),int(w*.83)
    middle=(left+right)//2
    ym=(top+h-3)//2
    draw.ellipse((left+8,top+9,left+18,top+19),fill=10)
    draw.ellipse((left+8,ym+7,left+18,ym+17),outline=10,width=2)
    draw.polygon([(middle+13,top+10),(middle+6,top+22),(middle+20,top+22)],fill=10)
    draw.polygon([(middle+13,ym+5),(middle+6,ym+19),(middle+20,ym+19)],outline=10)
    return picture


def test_bundle():
    # Start from the project's established synthetic 19-row, source-pinned
    # v1 receipt. Replace the *entire* synthetic source image and regenerate
    # every downstream v3/v4/v5/v6 from immutable source bytes.
    old_page,old_md,v1,_,_,_=earlier_fixture()
    w,h=240,260
    rng=random.Random(30)
    backing=Image.frombytes("L",(w,h),bytes(rng.randrange(256) for _ in range(w*h)))
    draw=ImageDraw.Draw(backing)
    top=215
    draw.rectangle((38,top,199,h-3),fill=252)
    draw.rectangle((38,top,199,h-3),outline=3,width=2)
    draw.ellipse((43,top+8,50,top+15),fill=4)
    draw.ellipse((43,top+27,50,top+34),outline=4,width=2)
    draw.polygon([(126,top+9),(120,top+17),(132,top+17)],fill=4)
    draw.polygon([(126,top+27),(120,top+35),(132,top+35)],outline=4)
    compressed=BytesIO()
    backing.save(compressed,format="JPEG",quality=95)
    embedded=compressed.getvalue()
    # Align the PDF render with the actually decoded embedded JPEG.
    with Image.open(BytesIO(embedded)) as im:
        fig=im.convert("L")
    page_image=Image.new("L",(900,800),255)
    page_image.paste(fig,(280,480))
    png=BytesIO();page_image.save(png,format="PNG");page=png.getvalue()
    image="![](data:image/jpeg;base64,"+base64.b64encode(embedded).decode("ascii")+")"
    md=(image+"\n\nSYNTHETIC FIG A\n"+image+"\n\nSYNTHETIC FIG B\n").encode("utf-8")
    v1["page_identity"]["source_render_png_sha256_private"]=pixel.sha256(page)
    v1["page_identity"]["mineru_markdown_sha256_private"]=pixel.sha256(md)
    v1["selected_image_sha256_private"]=pixel.sha256(embedded)
    v1["retained_figures"][1]["embedded_jpeg_sha256_private"]=pixel.sha256(embedded)
    v3=pixel.build(page,md,v1)
    v4,overlay4=feature.build(page,md,v1,v3)
    v5=spatial.build(page,md,v1,v3,v4,overlay4)
    overlay5=spatial.make_overlay(page,v5)
    report6,overlay6,html6=atlas.render(page,md,v1,v3,v4,overlay4,v5,overlay5)
    return (page,md,v1,v3,v4,overlay4,v5,overlay5,report6,overlay6,html6)


class B15LegendCellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle=test_bundle()

    def test_generic_synthetic_legend_border_has_four_cells(self):
        original=synthetic_legend()
        gray=np.asarray(original,dtype=np.uint8)
        rectangle=cells.find_frame(gray)
        items=cells.four_boxes(rectangle)
        self.assertEqual(len(items),4)
        self.assertEqual(len(set(tuple(q) for q in items)),4)
        self.assertGreater(rectangle[1],300)

    def test_missing_frame_is_explicit_abstention(self):
        gray=np.full((400,420),255,dtype=np.uint8)
        with self.assertRaises(cells.GateError):
            cells.find_frame(gray)

    def test_end_to_end_source_crops_not_gold(self):
        page,md,v1,v3,v4,overlay4,v5,overlay5,v6raw,v6sheet,v6html=self.bundle
        v6=pixel.json.loads(v6raw)
        raw,image=cells.build(page,md,v1,v6,v6sheet,v6html)
        report=pixel.json.loads(raw)
        self.assertEqual(report["legend_candidate_count"],4)
        self.assertEqual(report["schema_version"],7)
        self.assertFalse(report["marker_shape_verified"])
        self.assertFalse(report["label_to_marker_verified"])
        self.assertFalse(report["series_to_curve_correspondence_verified"])
        self.assertFalse(report["independent_gold_available"])
        self.assertIsNone(report["cer"])
        with Image.open(BytesIO(image)) as im:
            self.assertEqual(im.size,(900,480))

    def test_v6_sha_tamper_or_fake_gold_rejected(self):
        page,md,v1,v3,v4,overlay4,v5,overlay5,v6raw,v6sheet,v6html=self.bundle
        v6=pixel.json.loads(v6raw)
        v6["independent_gold_available"]=True
        with self.assertRaises(cells.GateError):
            cells.build(page,md,v1,v6,v6sheet,v6html)
        v6=pixel.json.loads(v6raw)
        with self.assertRaises(cells.GateError):
            cells.build(page,md,v1,v6,b"not original sheet",v6html)

    def test_private_pair_exclusive_and_audit_and_preserve_older_receipts(self):
        data=self.bundle
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            files=[
                ("p.png",data[0]),("m.md",data[1]),("v1.json",pixel.canonical(data[2])),
                ("v3.json",pixel.canonical(data[3])),("v4.json",pixel.canonical(data[4])),
                ("v4.png",data[5]),("v5.json",pixel.canonical(data[6])),
                ("v5.png",data[7]),("v6.json",data[8]),("v6.png",data[9]),
                ("v6.html",data[10])
            ]
            for name,raw in files:(root/name).write_bytes(raw)
            from types import SimpleNamespace
            args=SimpleNamespace(
                page_png=str(root/"p.png"),mineru_markdown=str(root/"m.md"),
                anchor_v1=str(root/"v1.json"),pixel_v3=str(root/"v3.json"),
                feature_v4=str(root/"v4.json"),feature_overlay_v4=str(root/"v4.png"),
                quad_v5=str(root/"v5.json"),quad_overlay_v5=str(root/"v5.png"),
                atlas_v6=str(root/"v6.json"),atlas_image_v6=str(root/"v6.png"),
                atlas_html_v6=str(root/"v6.html"),
                private_dir=str(root),audit_only=False)
            self.assertEqual(cells.run(args),4)
            args.audit_only=True
            self.assertEqual(cells.run(args),4)
            args.audit_only=False
            with self.assertRaises(cells.GateError):
                cells.run(args)
            (root/cells.FILENAME_PNG).write_bytes(b"changed")
            args.audit_only=True
            with self.assertRaises(cells.GateError):
                cells.run(args)
            self.assertEqual((root/"v6.html").read_bytes(),data[10])

    def test_pixel_source_changed_blocks_any_truth_claim(self):
        page,md,v1,v3,v4,over4,v5,over5,v6raw,v6sheet,v6html=self.bundle
        with self.assertRaises(cells.GateError):
            cells.build(page+b"tampered",md,v1,pixel.json.loads(v6raw),v6sheet,v6html)

    def test_unexpected_exception_never_leaks_to_logs(self):
        with patch.object(cells,"run",side_effect=RuntimeError("PRIVATE_OCR_TEXT_SECRET")):
            fields=("page-png","mineru-markdown","anchor-v1","pixel-v3",
                    "feature-v4","feature-overlay-v4","quad-v5","quad-overlay-v5",
                    "atlas-v6","atlas-image-v6","atlas-html-v6","private-dir")
            arguments=[item for k in fields for item in ("--"+k,"PRIVATE_PATH")]
            out=StringIO()
            with redirect_stdout(out):
                code=cells.main(arguments)
            self.assertEqual(code,2)
            self.assertEqual(out.getvalue().strip(),"ACS_B15_LEGEND_CELLS=REJECTED")


if __name__=="__main__":
    unittest.main()
