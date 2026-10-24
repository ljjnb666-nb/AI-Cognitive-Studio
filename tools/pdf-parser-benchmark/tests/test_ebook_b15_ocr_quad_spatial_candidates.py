"""Public synthetic-only B15 quad spatial gate: never test using real book text."""
import copy
from contextlib import redirect_stdout
from io import BytesIO,StringIO
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import ebook_private_b15_figure_pixel_registration as pixel
import ebook_b15_feature_crosscheck as feature
import ebook_b15_ocr_quad_spatial_candidates as spatial
from test_ebook_b15_feature_crosscheck import sample


def fixture():
    page,markdown,anchor,v3=sample()
    rows=[]
    for idx in range(19):
        # Ten inside synthetic figure; nine outside. All still unverified.
        x,y=(300+(idx%4)*30,520+(idx//4)*15) if idx<10 else (40+(idx%3)*12,90+(idx//3)*20)
        rows.append({
            "page_row_index":idx+1,
            "text_candidate":"SYNTHETIC_ROW_"+str(idx),
            "source_page_quad_candidate":[[x,y],[x+28,y],[x+28,y+12],[x,y+12]],
            "recognizer_confidence_not_accuracy":0.97})
    anchor["page_source_ocr_candidates"]=rows
    v3["prior_v1_anchor_sha256_private"]=pixel.sha256(pixel.canonical(anchor))
    v4,old_overlay=feature.build(page,markdown,anchor,v3)
    return page,markdown,anchor,v3,v4,old_overlay


class SpatialCandidateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data=fixture()

    def test_geometric_text_assignment_is_not_gold(self):
        report=spatial.build(*self.data)
        self.assertEqual(report["ocr_row_count"],19)
        self.assertEqual(report["schema_version"],5)
        self.assertEqual(len(report["ocr_candidate_spatial_rows_private"]),19)
        self.assertFalse(report["figure_roi_geometry_independently_verified"])
        self.assertFalse(report["label_to_marker_correspondence_verified"])
        self.assertFalse(report["independent_gold_available"])
        self.assertIsNone(report["cer"])
        self.assertGreater(report["spatial_bucket_counts"]["MOSTLY_WITHIN_UNVERIFIED_ROI"],0)
        self.assertGreater(report["spatial_bucket_counts"]["OUTSIDE_UNVERIFIED_ROI"],0)
        with Image.open(BytesIO(spatial.make_overlay(self.data[0],report))) as img:
            self.assertEqual(img.size,(900,800))

    def test_tampered_coordinates_or_duplicate_row_rejected(self):
        page,md,v1,v3,v4,overlay=copy.deepcopy(self.data)
        v1["page_source_ocr_candidates"][0]["source_page_quad_candidate"][0][0]=-7
        with self.assertRaises(spatial.GateError):
            spatial.build(page,md,v1,v3,v4,overlay)
        page,md,v1,v3,v4,overlay=copy.deepcopy(self.data)
        v1["page_source_ocr_candidates"][1]["page_row_index"]=1
        with self.assertRaises(spatial.GateError):
            spatial.build(page,md,v1,v3,v4,overlay)

    def test_wrong_v4_overlay_or_fake_authority_rejected(self):
        page,md,v1,v3,v4,overlay=copy.deepcopy(self.data)
        with self.assertRaises(spatial.GateError):
            spatial.build(page,md,v1,v3,v4,b"counterfeit")
        page,md,v1,v3,v4,overlay=copy.deepcopy(self.data)
        v4["independent_gold_available"]=True
        with self.assertRaises(spatial.GateError):
            spatial.build(page,md,v1,v3,v4,overlay)

    def test_partial_and_inside_overlap_buckets(self):
        self.assertEqual(spatial.spatial_bucket(1.0),"MOSTLY_WITHIN_UNVERIFIED_ROI")
        self.assertEqual(spatial.spatial_bucket(0.01),"PARTIALLY_INTERSECTS_UNVERIFIED_ROI")
        self.assertEqual(spatial.spatial_bucket(0.0),"OUTSIDE_UNVERIFIED_ROI")
        self.assertEqual(spatial.overlap_fraction([0,0,10,10],[5,0,15,10]),0.5)

    def test_private_frozen_pair_and_tamper_rejection(self):
        page,md,v1,v3,v4,old_overlay=self.data
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            inputs={"p.png":page,"m.md":md,"v1.json":pixel.canonical(v1),
                    "v3.json":pixel.canonical(v3),"v4.json":pixel.canonical(v4),
                    "v4.png":old_overlay}
            for name,data in inputs.items():
                (root/name).write_bytes(data)
            def call(audit):
                return spatial.run(*(root/n for n in inputs),
                                   root/"v5.json",root/"v5.png",audit_only=audit)
            first=call(False)
            self.assertEqual(first,call(True))
            with self.assertRaises(spatial.GateError):
                call(False)
            (root/"v5.png").write_bytes(b"bad")
            with self.assertRaises(spatial.GateError):
                call(True)

    def test_private_unexpected_exception_no_stdout_leak(self):
        with patch.object(spatial,"run",side_effect=ValueError("DO_NOT_ECHO_PRIVATE_OCR_TEXT")):
            arguments=[]
            for name in ("page-png","mineru-markdown","anchor-v1","pixel-v3",
                         "feature-v4","feature-overlay-v4","private-output","private-overlay"):
                arguments+=["--"+name,"dummy"]
            out=StringIO()
            with redirect_stdout(out):
                rc=spatial.main(arguments)
            self.assertEqual(rc,2)
            self.assertEqual(out.getvalue().strip(),"ACS_B15_QUAD_SPATIAL=REJECTED")


if __name__=="__main__":
    unittest.main()
