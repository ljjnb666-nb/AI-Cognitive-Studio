"""Synthetic offline tests for local OCR receipts. No model or private book needed."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "run_rapidocr_candidate_offline.py"
spec = importlib.util.spec_from_file_location("acs_private_rapidocr_candidate_runner", SOURCE)
assert spec and spec.loader
runner = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runner
spec.loader.exec_module(runner)
comp = runner.comp

MODEL = "b" * 64


class LocalRapidOcrReceiptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="acs-ocr-receipt-synthetic-")
        self.root = Path(self.tmp.name)
        (self.root / "output").mkdir()
        self.pdf_bytes = b"%PDF-1.4\nSYNTHETIC_TEST_ONLY"
        (self.root / "source.pdf").write_bytes(self.pdf_bytes)
        self.source = {
            "pdf": "source.pdf", "book_id": "B16", "size_bytes": len(self.pdf_bytes),
            "sha256": hashlib.sha256(self.pdf_bytes).hexdigest(),
            "page_count": 1, "physical_page_1_based": 1,
        }

    def tearDown(self):
        self.tmp.cleanup()

    def fake_run(self, *args, timeout):
        if args == ("--probe",):
            return {
                "schemaVersion": 1, "status": "READY",
                "rapidocr": runner.ENGINE_VERSION, "onnxruntime": runner.ONNX_VERSION,
                "modelSha256": MODEL,
            }
        self.assertEqual(args, ("--pdf", str(self.root / "source.pdf"), "--page", "0"))
        return {"schemaVersion": 1, "status": "SUCCEEDED", "text": "SYNTHETIC OCR 文本"}

    def emit(self, fake=None):
        with patch.object(comp, "validate_source", return_value=self.source):
            return runner.run_candidate(
                self.root, self.source, "output", "rapidocr-p1",
                runner=self.fake_run if fake is None else fake,
            )

    def manifest(self):
        (self.root / "mineru.txt").write_text("SYNTHETIC OCR 文本", encoding="utf-8")
        return {
            "schema_version": 1, "source": self.source,
            "candidates": [
                {"engine": "mineru", "revision": "demo-v1", "text": "mineru.txt",
                 "source_sha256": self.source["sha256"], "physical_page_1_based": 1},
                {"engine": "rapidocr", "revision": runner.ENGINE_VERSION,
                 "text": "output/rapidocr-p1.txt",
                 "receipt": "output/rapidocr-p1.receipt.json",
                 "source_sha256": self.source["sha256"], "physical_page_1_based": 1},
            ], "reference": None,
        }

    def compare(self, manifest):
        with patch.object(comp, "validate_source", return_value=self.source):
            return comp.compare(self.root, manifest)

    def test_real_runner_protocol_receipt_matches_exact_candidate_text(self):
        outcome = self.emit()
        self.assertEqual(outcome["status"], "SUCCEEDED")
        self.assertNotIn(str(self.root), json.dumps(outcome))
        self.assertNotIn("SYNTHETIC OCR 文本", json.dumps(outcome))
        self.assertEqual(outcome["local_text_receipt"], "WRITTEN_NOT_INDEPENDENTLY_ATTESTED")
        rec = json.loads((self.root / "output/rapidocr-p1.receipt.json").read_text())
        data = (self.root / "output/rapidocr-p1.txt").read_bytes()
        self.assertEqual(rec["text_sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(rec["source_sha256"], self.source["sha256"])
        self.assertEqual(rec["model_sha256"], MODEL)
        comparison = self.compare(self.manifest())
        self.assertEqual(comparison["pairwise"][0]["edit_distance"], 0)
        self.assertEqual(comparison["candidate_receipts"], [
            {"engine": "mineru", "state": "DECLARED_ONLY"},
            {"engine": "rapidocr", "state": "LOCAL_HASH_CONSISTENT_SELF_ATTESTED"},
        ])
        self.assertIsNone(comparison["official_cer"])
        self.assertIsNone(comparison["engine_ranking"])

    def test_tampering_output_text_fails_closed(self):
        self.emit()
        (self.root / "output/rapidocr-p1.txt").write_text("SYNTHETIC OCR 文", encoding="utf-8")
        with self.assertRaisesRegex(comp.Blocked, "RECEIPT_TEXT_MISMATCH"):
            self.compare(self.manifest())

    def test_tampering_receipt_lineage_fails_closed(self):
        self.emit()
        path = self.root / "output/rapidocr-p1.receipt.json"
        receipt = json.loads(path.read_text())
        receipt["source_sha256"] = "f" * 64
        path.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaisesRegex(comp.Blocked, "RECEIPT_SOURCE_PAGE_MISMATCH"):
            self.compare(self.manifest())

    def test_out_of_page_receipt_fails_closed(self):
        self.emit()
        path = self.root / "output/rapidocr-p1.receipt.json"
        receipt = json.loads(path.read_text())
        receipt["physical_page_1_based"] = 2
        path.write_text(json.dumps(receipt), encoding="utf-8")
        with self.assertRaisesRegex(comp.Blocked, "RECEIPT_SOURCE_PAGE_MISMATCH"):
            self.compare(self.manifest())

    def test_wrong_model_provenance_fails_closed(self):
        def fake(*args, timeout):
            answer = self.fake_run(*args, timeout=timeout)
            if args == ("--probe",):
                answer["modelSha256"] = "NOT_A_SHA"
            return answer
        with self.assertRaisesRegex(comp.Blocked, "RAPIDOCR_PROBE_INVALID"):
            self.emit(fake)
        self.assertEqual(list((self.root / "output").iterdir()), [])

    def test_source_changes_during_ocr_fails_without_output(self):
        def fake(*args, timeout):
            answer = self.fake_run(*args, timeout=timeout)
            if args and args[0] == "--pdf":
                (self.root / "source.pdf").write_bytes(b"%PDF-1.4\nTAMPERED_SOURCE")
            return answer
        with self.assertRaisesRegex(comp.Blocked, "SOURCE_CHANGED_DURING_OCR"):
            self.emit(fake)
        self.assertEqual(list((self.root / "output").iterdir()), [])

    def test_existing_output_denied_no_clobber(self):
        self.emit()
        original = (self.root / "output/rapidocr-p1.txt").read_bytes()
        with self.assertRaisesRegex(comp.Blocked, "PRIVATE_OUTPUT_ALREADY_EXISTS"):
            self.emit()
        self.assertEqual((self.root / "output/rapidocr-p1.txt").read_bytes(), original)

    def test_symlinked_output_directory_denied(self):
        outside = self.root / "outside"
        outside.mkdir()
        try:
            (self.root / "linked").symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("Symlinks unavailable")
        with self.assertRaisesRegex(comp.Blocked, "UNSAFE_PRIVATE_OUTPUT"):
            runner.directory_inside(self.root, "linked")

    def test_receipt_is_not_a_forgery_proof(self):
        self.emit()
        compare = self.compare(self.manifest())
        self.assertEqual(compare["candidate_lineage"], "DECLARED_NOT_INDEPENDENTLY_ATTESTED")
        self.assertIn("SELF_ATTESTED", compare["candidate_receipts"][1]["state"])

    def test_unsafe_output_stem_denied(self):
        with self.assertRaisesRegex(comp.Blocked, "PRIVATE_OUTPUT_NAME_INVALID"):
            self.emit(fake=None) if False else runner.run_candidate(
                self.root, self.source, "output", "../escape", runner=self.fake_run
            )


if __name__ == "__main__":
    unittest.main()
