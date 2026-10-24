"""Public tests use purely synthetic page and legend glyph pixels."""
from contextlib import redirect_stdout
from io import StringIO,BytesIO
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
import cv2
from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import ebook_private_b15_figure_pixel_registration as pixel
import ebook_b15_four_legend_source_cells as legend
import ebook_b15_marker_morphology as marker
from test_ebook_b15_four_legend_source_cells import test_bundle,synthetic_legend


def synthetic_files(root):
    raw=test_bundle()
    inputs=[
        ("p.png",raw[0]),("m.md",raw[1]),("v1.json",pixel.canonical(raw[2])),
        ("v3.json",pixel.canonical(raw[3])),("v4.json",pixel.canonical(raw[4])),
        ("v4.png",raw[5]),("v5.json",pixel.canonical(raw[6])),
        ("v5.png",raw[7]),("v6.json",raw[8]),("v6.png",raw[9]),("v6.html",raw[10])
    ]
    for name,blob in inputs:(root/name).write_bytes(blob)
    args=SimpleNamespace(page_png=str(root/"p.png"),mineru_markdown=str(root/"m.md"),
         anchor_v1=str(root/"v1.json"),pixel_v3=str(root/"v3.json"),
         feature_v4=str(root/"v4.json"),feature_overlay_v4=str(root/"v4.png"),
         quad_v5=str(root/"v5.json"),quad_overlay_v5=str(root/"v5.png"),
         atlas_v6=str(root/"v6.json"),atlas_image_v6=str(root/"v6.png"),
         atlas_html_v6=str(root/"v6.html"),private_dir=str(root),audit_only=False)
    legend.run(args)
    args.legend_v7=str(root/legend.FILENAME_JSON)
    args.legend_image_v7=str(root/legend.FILENAME_PNG)
    return args


class MarkerMorphologyTests(unittest.TestCase):
    def test_four_synthetic_shapes_are_source_proposals_not_gold(self):
        im=synthetic_legend()
        arr=np.asarray(im,dtype=np.uint8)
        frame=legend.find_frame(arr)
        boxes=legend.four_boxes(frame)
        got=[marker.shape_candidate(arr,box) for box in boxes]
        self.assertEqual([x["classification"] for x in got],
                         list(marker.PROVISIONAL_EXPECTED))
        self.assertTrue(all(x["status"]=="SOURCE_PIXEL_GLYPH_SHAPE_CANDIDATE_NOT_GOLD" for x in got))

    def test_blank_and_ambiguous_inputs_abstain(self):
        blank=np.full((300,400),255,dtype=np.uint8)
        r=marker.shape_candidate(blank,[60,200,200,260])
        self.assertIsNone(r["classification"])
        self.assertTrue(r["status"].startswith("ABSTAIN"))

    def test_bounds_and_shapes_reject_malicious_geometry(self):
        img=np.full((300,400),255,dtype=np.uint8)
        for q in ([70,70,60,80],[-1,10,30,20],[10,20,10,30],[0,0,900,30]):
            with self.assertRaises(marker.GateError):
                marker.shape_candidate(img,q)

    def test_private_source_chain_and_mutation_rejection(self):
        with tempfile.TemporaryDirectory() as d:
            args=synthetic_files(Path(d))
            report,image,n,m=marker.reconstruct(args)
            payload=pixel.json.loads(report)
            self.assertEqual(payload["schema_version"],8)
            self.assertFalse(payload["independent_gold_available"])
            self.assertFalse(payload["marker_shape_independently_verified"])
            self.assertFalse(payload["symbol_to_curve_verified"])
            self.assertIsNone(payload["cer"])
            self.assertEqual(payload["marker_source_pixel_candidate_count"],n)
            self.assertEqual(payload["provisional_reference_shape_agreement_count_not_gold"],m)
            self.assertEqual(len(payload["legend_rows_private"]),4)
            with Image.open(BytesIO(image)) as overlay:
                self.assertEqual(overlay.mode,"RGB")
            self.assertTrue((Path(d)/legend.FILENAME_JSON).exists())

    def test_private_pair_exclusive_and_reaudit(self):
        with tempfile.TemporaryDirectory() as d:
            args=synthetic_files(Path(d))
            first=marker.run(args)
            args.audit_only=True
            self.assertEqual(first,marker.run(args))
            args.audit_only=False
            with self.assertRaises(marker.GateError):
                marker.run(args)
            (Path(d)/marker.OVERLAY).write_bytes(b"corrupt")
            args.audit_only=True
            with self.assertRaises(marker.GateError):
                marker.run(args)

    def test_fake_frozen_v7_bytes_cannot_be_trusted(self):
        with tempfile.TemporaryDirectory() as d:
            args=synthetic_files(Path(d))
            (Path(d)/legend.FILENAME_JSON).write_bytes(b"fake source")
            with self.assertRaises(marker.GateError):
                marker.reconstruct(args)

    def test_private_exception_is_anonymous(self):
        with patch.object(marker,"run",side_effect=RuntimeError("PRIVATE_OCR_OR_SHA")):
            names=("page-png","mineru-markdown","anchor-v1","pixel-v3",
                   "feature-v4","feature-overlay-v4","quad-v5","quad-overlay-v5",
                   "atlas-v6","atlas-image-v6","atlas-html-v6","legend-v7",
                   "legend-image-v7","private-dir")
            argv=[v for name in names for v in ("--"+name,"PRIVATE_PATH")]
            sink=StringIO()
            with redirect_stdout(sink):
                code=marker.main(argv)
            self.assertEqual(code,2)
            self.assertEqual(sink.getvalue().strip(),"ACS_B15_MARKER_MORPHOLOGY=REJECTED")


if __name__=="__main__":
    unittest.main()
