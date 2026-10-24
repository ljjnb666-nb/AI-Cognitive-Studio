"""Synthetic only: never include real B15 page data in public repository tests."""
from contextlib import redirect_stdout
from io import BytesIO,StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import ebook_private_b15_figure_pixel_registration as pixel
import ebook_b15_ocr_quad_spatial_candidates as spatial
import ebook_b15_private_legend_contact_sheet as atlas
from test_ebook_b15_ocr_quad_spatial_candidates import fixture


def sample():
    page,markdown,v1,v3,v4,v4_overlay=fixture()
    v5=spatial.build(page,markdown,v1,v3,v4,v4_overlay)
    v5_overlay=spatial.make_overlay(page,v5)
    return (page,markdown,v1,v3,v4,v4_overlay,v5,v5_overlay)


def persisted(root):
    inputs=sample()
    filenames=("page.png","mineru.md","v1.json","v3.json","v4.json",
               "v4.png","v5.json","v5.png")
    for i,(name,raw) in enumerate(zip(filenames,inputs)):
        (root/name).write_bytes(pixel.canonical(raw) if i in (2,3,4,6) else raw)
    return SimpleNamespace(
        page_png=str(root/filenames[0]),mineru_markdown=str(root/filenames[1]),
        anchor_v1=str(root/filenames[2]),pixel_v3=str(root/filenames[3]),
        feature_v4=str(root/filenames[4]),feature_overlay_v4=str(root/filenames[5]),
        quad_v5=str(root/filenames[6]),quad_overlay_v5=str(root/filenames[7]),
        private_output_dir=str(root),audit_only=False)


class ContactSheetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contents=sample()

    def test_synthetic_source_sheet_has_nineteen_rows_no_pseudo_gold(self):
        report,png,doc=atlas.render(*self.contents)
        data=pixel.json.loads(report)
        self.assertEqual(data["row_count"],19)
        self.assertEqual(data["schema_version"],6)
        self.assertFalse(data["label_to_symbol_verified"])
        self.assertFalse(data["symbol_to_curve_verified"])
        self.assertFalse(data["independent_gold_available"])
        self.assertIsNone(data["cer"])
        self.assertEqual(len(data["source_context_rows_private"]),19)
        with Image.open(BytesIO(png)) as im:
            self.assertEqual(im.size,(atlas.WIDTH,atlas.HEADER_HEIGHT+19*atlas.ROW_HEIGHT))
        self.assertIn(b"SYNTHETIC_ROW_0",doc)

    def test_crops_outside_figure_do_not_invent_marker_context(self):
        report,_,_=atlas.render(*self.contents)
        data=pixel.json.loads(report)
        # The synthetic test intentionally places nine rows outside the ROI.
        outer=data["source_context_rows_private"][-1]
        self.assertIsNone(outer["left_original_pixel_box_private"])
        self.assertIsNone(outer["right_original_pixel_box_private"])
        self.assertIsNotNone(outer["text_original_pixel_box_private"])

    def test_local_html_escapes_untrusted_ocr_markup(self):
        rows=[{"ocr_text_private_not_gold":"<script>alert(1)</script>&quotes"} for _ in range(19)]
        decoded=atlas.html_document(rows,atlas.IMG_NAME).decode("utf-8")
        self.assertNotIn("<script>alert(1)</script>",decoded)
        self.assertIn("&lt;script&gt;",decoded)
        self.assertIn("Content-Security-Policy",decoded)

    def test_forged_v5_or_mismatched_overlay_rejected(self):
        page,md,v1,v3,v4,overlay,v5,v5overlay=self.contents
        tampered=dict(v5,independent_gold_available=True)
        with self.assertRaises(atlas.PrivateAtlasError):
            atlas.render(page,md,v1,v3,v4,overlay,tampered,v5overlay)
        with self.assertRaises(atlas.PrivateAtlasError):
            atlas.render(page,md,v1,v3,v4,overlay,v5,b"spoofed-pixels")

    def test_three_frozen_outputs_and_exact_audit(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            args=persisted(root)
            atlas.run(args)
            args.audit_only=True
            atlas.run(args)
            args.audit_only=False
            with self.assertRaises(atlas.PrivateAtlasError):
                atlas.run(args)
            (root/atlas.DOC_NAME).write_bytes(b"tampered")
            args.audit_only=True
            with self.assertRaises(atlas.PrivateAtlasError):
                atlas.run(args)

    def test_preexisting_partial_output_rejected_without_overwriting(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            args=persisted(root)
            original=b"NEVER_OVERWRITE"
            (root/atlas.IMG_NAME).write_bytes(original)
            with self.assertRaises(atlas.PrivateAtlasError):
                atlas.run(args)
            self.assertEqual((root/atlas.IMG_NAME).read_bytes(),original)
            self.assertFalse((root/atlas.REPORT_NAME).exists())
            self.assertFalse((root/atlas.DOC_NAME).exists())

    def test_any_unexpected_private_error_only_fixed_rejection(self):
        with patch.object(atlas,"read_inputs",side_effect=RuntimeError("PRIVATE_OCR_CONTENT")):
            argv=[]
            for name in ("page-png","mineru-markdown","anchor-v1","pixel-v3",
                         "feature-v4","feature-overlay-v4","quad-v5","quad-overlay-v5",
                         "private-output-dir"):
                argv.extend(("--"+name,"PRIVATE_PATH"))
            out=StringIO()
            with redirect_stdout(out):
                code=atlas.main(argv)
            self.assertEqual(code,2)
            self.assertEqual(out.getvalue().strip(),"ACS_B15_SOURCE_ATLAS=REJECTED")


if __name__=="__main__":
    unittest.main()
