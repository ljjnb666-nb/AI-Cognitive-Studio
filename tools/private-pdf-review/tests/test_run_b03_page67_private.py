"""One-command B03 orchestration tests using synthetic files and mocked OCR.

Never reads the user's B03 original or loads real models on hosted CI.
"""
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

TARGET = Path(__file__).resolve().parents[1] / "run_b03_page67_private.py"
spec = importlib.util.spec_from_file_location("acs_b03_one_shot_test", TARGET)
assert spec and spec.loader
app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = app
spec.loader.exec_module(app)


class OneCommandPrivateB03Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.file = self.root / "B03-original.pdf"
        self.file.write_bytes(b"%PDF-1.4\nSYNTHETIC_NO_REAL_SOURCE")
        self.calls = []

    def tearDown(self):
        self.temporary.cleanup()

    def fake_ocr(self, root, source, directory, stem):
        self.calls.append((root, source, directory, stem))
        self.assertEqual(source["book_id"], "B03")
        self.assertEqual(source["pdf"], "B03-original.pdf")
        self.assertEqual(source["size_bytes"], app.identity.EXPECTED_SIZE)
        self.assertEqual(source["sha256"], app.identity.EXPECTED_SHA256)
        self.assertEqual(source["page_count"], 271)
        self.assertEqual(source["physical_page_1_based"], 67)
        self.assertEqual(directory, app.OUTPUT_DIR)
        self.assertEqual(stem, app.STEM)
        self.assertTrue((root / app.OUTPUT_DIR).is_dir())
        return {"status": "SUCCEEDED"}

    def test_pinned_source_to_runner_pipeline(self):
        with patch.object(app.identity, "identify_exact_original", return_value=self.file):
            result = app.execute(self.root, ocr=self.fake_ocr)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(result["physical_page_1_based"], 67)
        self.assertEqual(result["private_receipt"], "LOCAL_UNSIGNED_HASH_BOUND")
        self.assertIsNone(result["official_cer"])
        self.assertIsNone(result["engine_ranking"])
        self.assertNotIn(str(self.root), json.dumps(result))

    def test_missing_exact_book_refuses_ocr_and_does_not_make_output(self):
        with self.assertRaisesRegex(app.identity.ReviewBlocked, "B03_SHA_NOT_FOUND"):
            app.execute(self.root, ocr=self.fake_ocr)
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / app.OUTPUT_DIR).exists())

    def test_refuse_linked_candidate_folder(self):
        outside = self.root / "outside"
        outside.mkdir()
        link = self.root / app.OUTPUT_DIR
        try:
            link.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with patch.object(app.identity, "identify_exact_original", return_value=self.file):
            with self.assertRaisesRegex(app.comp.Blocked, "UNSAFE_PRIVATE_OUTPUT"):
                app.execute(self.root, ocr=self.fake_ocr)
        self.assertEqual(self.calls, [])

    def test_cli_redacts_runtime_error_and_secret_path(self):
        private_path = self.root / "PRIVATE_SENTINEL_DO_NOT_OUTPUT"
        with patch.object(app, "execute", side_effect=RuntimeError(str(private_path))):
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                status = app.main(["--root", str(self.root)])
        self.assertEqual(status, 2)
        self.assertNotIn("PRIVATE_SENTINEL", stdout.getvalue())
        self.assertNotIn(str(self.root), stdout.getvalue())
        self.assertIn('"reason":"PRIVATE_B03_OCR_BLOCKED"', stdout.getvalue())

    def test_model_failure_not_reported_successful(self):
        with patch.object(app.identity, "identify_exact_original", return_value=self.file):
            with self.assertRaisesRegex(app.comp.Blocked, "RAPIDOCR_PAGE_FAILED"):
                app.execute(self.root, ocr=lambda *_: {"status": "FAILED"})


if __name__ == "__main__":
    unittest.main()
