"""No-private-text tests for B15 v5 numeric-only reporting."""
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import ebook_private_b15_figure_pixel_registration as pixel
import ebook_b15_ocr_quad_spatial_candidates as spatial
import ebook_b15_safe_spatial_coverage as gate
from test_ebook_b15_ocr_quad_spatial_candidates import fixture


def sources(directory):
    page,md,v1,v3,v4,overlay=fixture()
    result=spatial.build(page,md,v1,v3,v4,overlay)
    root=Path(directory)
    payload={
        "page.png":page,"md.txt":md,
        "v1.json":pixel.canonical(v1),"v3.json":pixel.canonical(v3),
        "v4.json":pixel.canonical(v4),"v4.png":overlay,
        "v5.json":pixel.canonical(result),
    }
    for name,data in payload.items():
        (root/name).write_bytes(data)
    return tuple(root/name for name in payload),result


class SpatialAggregateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sandbox=tempfile.TemporaryDirectory()
        cls.files,cls.report=sources(cls.sandbox.name)

    @classmethod
    def tearDownClass(cls):
        cls.sandbox.cleanup()

    def test_only_bounded_counts_sum_to_nineteen(self):
        result=gate.trusted_metrics(*self.files)
        self.assertEqual(sum(result.values()),19)
        self.assertGreater(result["INSIDE"],0)
        self.assertGreater(result["OUTSIDE"],0)
        self.assertEqual(set(result),{"INSIDE","PARTIAL","OUTSIDE"})

    def test_cli_never_prints_original_ocr_or_bbox(self):
        names=("page-png","mineru-markdown","anchor-v1","pixel-v3",
               "feature-v4","feature-overlay-v4","quad-v5")
        argv=[v for pair in zip(("--"+n for n in names),
                                (str(f) for f in self.files)) for v in pair]
        output=StringIO()
        with redirect_stdout(output):
            exit_code=gate.main(argv)
        self.assertEqual(exit_code,0)
        self.assertIn("ACS_B15_V5_TOTAL=19",output.getvalue())
        self.assertNotIn("SYNTHETIC_ROW_",output.getvalue())
        self.assertNotIn("ocr_text_private",output.getvalue())
        self.assertNotIn("source_page_quad_candidate",output.getvalue())
        self.assertNotIn(str(self.files[0]),output.getvalue())

    def test_tampered_buckets_rejected_without_echoing_content(self):
        with tempfile.TemporaryDirectory() as directory:
            arr,_=sources(directory)
            import json
            v5=arr[-1]
            doc=json.loads(v5.read_text("utf-8"))
            doc["spatial_bucket_counts"]["MOSTLY_WITHIN_UNVERIFIED_ROI"]=19
            v5.write_bytes(pixel.canonical(doc))
            with self.assertRaises(gate.PrivateProjectionError):
                gate.trusted_metrics(*arr)

    def test_forged_gold_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            arr,_=sources(directory)
            import json
            v5=arr[-1]
            doc=json.loads(v5.read_text("utf-8"))
            doc["independent_gold_available"]=True
            v5.write_bytes(pixel.canonical(doc))
            with self.assertRaises(gate.PrivateProjectionError):
                gate.trusted_metrics(*arr)

    def test_unknown_runtime_exception_only_fixed_rejection(self):
        with patch.object(gate,"trusted_metrics",
                          side_effect=RuntimeError("PRIVATE_CHINESE_OCR_DO_NOT_ECHO")):
            argv=[]
            for field in ("page-png","mineru-markdown","anchor-v1","pixel-v3",
                          "feature-v4","feature-overlay-v4","quad-v5"):
                argv.extend(("--"+field,"PRIVATE_PATH_DO_NOT_ECHO"))
            text=StringIO()
            with redirect_stdout(text):
                rc=gate.main(argv)
            self.assertEqual(rc,2)
            self.assertEqual(text.getvalue().strip(),"ACS_B15_V5_COVERAGE=REJECTED")

    def test_missing_source_never_falls_back_to_self_report(self):
        with tempfile.TemporaryDirectory() as directory:
            arr,_=sources(directory)
            arr[0].unlink()
            with self.assertRaises(pixel.GateError):
                gate.trusted_metrics(*arr)


if __name__=="__main__":
    unittest.main()
