"""01C contracts: synthetic-only, never uses private books or GPU."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess

from run_real_book_matrix import selected_matrix, manifest_fixture, evidence_row, report_status, NATIVE


class MatrixContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fixture_root = self.root / "fixtures"
        self.fixture_root.mkdir()
        (self.root / "reports").mkdir()
        self.parent = b"%PDF-1.4\nsynthetic parent\n"
        self.subset = b"%PDF-1.4\nsynthetic child\n"
        for f, data in (("RB-PDF-01.pdf", self.parent), ("RB-PDF-11.pdf", self.subset)):
            (self.fixture_root / f).write_bytes(data)
        self.manifest = self.fixture_root / "fixtures.manifest.json"
        self.record = {
            "id": "RB-PDF-11",
            "filename": "RB-PDF-11.pdf",
            "fixtureClass": "private-real-page-subset",
            "expectedSha256": hashlib.sha256(self.subset).hexdigest(),
            "declaredBytes": len(self.subset),
            "sourceFixtureId": "RB-PDF-01",
            "sourceSha256": hashlib.sha256(self.parent).hexdigest(),
            "sourcePages1Based": [22, 107, 192],
        }
        self.manifest.write_text(json.dumps({"fixtures": [
            {"id": "RB-PDF-01", "filename": "RB-PDF-01.pdf",
             "declaredBytes": len(self.parent),
             "expectedSha256": self.record["sourceSha256"]},
            self.record,
        ]}), "utf-8")

    def test_default_runs_six_native_modes_in_serial_order(self):
        self.assertEqual(len(selected_matrix(False, False)), 6)
        self.assertEqual(selected_matrix(False, False), NATIVE)

    def test_heavy_models_require_explicit_readiness(self):
        with self.assertRaisesRegex(ValueError, "MODEL_READINESS_CONFIRMATION_REQUIRED"):
            selected_matrix(True, False)
        self.assertEqual(len(selected_matrix(True, True)), 10)

    def test_expected_rejection_preserves_evidence_and_continues(self):
        jobs = (("pdfjs", "default", "RB-PDF-12"), ("liteparse", "default", "RB-PDF-12"))
        rows = [{"status": "EXPECTED_CAPABILITY_REJECTION"}, {"status": "EXECUTION_OK"}]
        self.assertEqual(report_status(rows, jobs, True),
                         "BASELINE_COMPLETE_WITH_EXPECTED_REJECTIONS")
        self.assertEqual(report_status(rows[:1], jobs, True), "INCOMPLETE_OR_FAILED")
        self.assertEqual(report_status([rows[0], {"status": "NOT_ACCEPTED"}], jobs, True),
                         "INCOMPLETE_OR_FAILED")
        self.assertEqual(report_status(rows, jobs, False), "INCOMPLETE_OR_FAILED")
        self.assertEqual(report_status([{"status": "EXECUTION_OK"}] * 2, jobs, True),
                         "EXECUTION_PASS_ONLY")

    def test_mineru_solo_skips_native_negative_controls_and_docling(self):
        jobs = selected_matrix(False, True, "mineru-flash")
        self.assertEqual(jobs, (("mineru", "flash", "RB-PDF-12"),
                                ("mineru", "flash", "RB-PDF-13")))
        self.assertEqual(selected_matrix(False, True, "docling-ocr"),
                         (("docling", "ocr", "RB-PDF-12"),
                          ("docling", "ocr", "RB-PDF-13")))
        with self.assertRaisesRegex(ValueError, "MODEL_READINESS_CONFIRMATION_REQUIRED"):
            selected_matrix(False, False, "mineru-flash")
        with self.assertRaisesRegex(ValueError, "INVALID_OR_AMBIGUOUS_SUITE"):
            selected_matrix(True, True, "mineru-flash")
        with self.assertRaisesRegex(ValueError, "INVALID_OR_AMBIGUOUS_SUITE"):
            selected_matrix(False, True, "malicious")

    def test_private_fixture_and_parent_lineage_verified(self):
        self.assertEqual(manifest_fixture(self.root, "RB-PDF-11")["sourcePages1Based"], [22, 107, 192])
        (self.fixture_root / "RB-PDF-11.pdf").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "PRIVATE_FIXTURE_INTEGRITY_FAILURE"):
            manifest_fixture(self.root, "RB-PDF-11")

    def test_manifest_swapped_parent_is_rejected(self):
        manifest = json.loads(self.manifest.read_text())
        manifest["fixtures"][0]["expectedSha256"] = "0" * 64
        self.manifest.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "PRIVATE_SUBSET_PARENT_CONFLICT"):
            manifest_fixture(self.root, "RB-PDF-11")

    def test_parent_pdf_modified_without_manifest_update_rejected(self):
        (self.fixture_root / "RB-PDF-01.pdf").write_bytes(b"swapped")
        with self.assertRaisesRegex(ValueError, "PRIVATE_SUBSET_PARENT_FILE_CHANGED"):
            manifest_fixture(self.root, "RB-PDF-11")

    def test_source_page_map_modified_rejected(self):
        manifest = json.loads(self.manifest.read_text())
        manifest["fixtures"][1]["sourcePages1Based"] = [1, 2, 3]
        self.manifest.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "PRIVATE_SUBSET_PAGE_MAP_CONFLICT"):
            manifest_fixture(self.root, "RB-PDF-11")

    def test_stdout_success_needs_checksum_and_zero_exit(self):
        fixture = manifest_fixture(self.root, "RB-PDF-11")
        report = {
            "benchmarkOutcome": {"status": "OK", "tempClean": True, "accepted": True},
            "run": {"id": "synthetic"},
            "document": {"inputSha256": fixture["expectedSha256"], "fixtureId": "RB-PDF-11"},
            "reliability": {"exitCode": 0, "crashed": False, "failureKind": None, "timeout": False,
                            "partialOutput": False, "oom": False},
            "extraction": {"extractedPages": 3, "characters": 42},
        }
        job = ("pdfjs", "default", "RB-PDF-11")
        ok = evidence_row(job, CompletedProcess([], 0, json.dumps(report), ""), 0.12, fixture)
        self.assertEqual(ok["status"], "EXECUTION_OK")
        self.assertEqual(ok["extractedPages"], 3)
        self.assertEqual(ok["sourcePages1Based"], [22, 107, 192])

        bad = evidence_row(job, CompletedProcess([], 3, json.dumps(report), ""), 0.12, fixture)
        self.assertEqual(bad["status"], "NOT_ACCEPTED")
        report["document"]["inputSha256"] = "0" * 64
        wrong = evidence_row(job, CompletedProcess([], 0, json.dumps(report), ""), 0.12, fixture)
        self.assertEqual(wrong["status"], "NOT_ACCEPTED")
        missing = evidence_row(job, CompletedProcess([], 0, "not-json", ""), 0.12, fixture)
        self.assertEqual(missing["status"], "NOT_ACCEPTED")

    def test_expected_scan_refusal_is_non_success_but_continuable(self):
        fixture = manifest_fixture(self.root, "RB-PDF-11")
        fixture["id"] = "RB-PDF-12"
        result = {
            "benchmarkOutcome": {"status": "PARSER_FAILED", "tempClean": True, "accepted": False},
            "run": {"id": "synthetic-negative"},
            "document": {"inputSha256": fixture["expectedSha256"], "fixtureId": "RB-PDF-12"},
            "reliability": {
                "exitCode": 3, "crashed": False, "failureKind": "EXPECTED_CAPABILITY_REJECTION",
                "timeout": False, "partialOutput": False, "oom": False,
                "warnings": ["PARSER_ERROR: SOURCE_OCR_REQUIRED"],
            },
            "extraction": {"extractedPages": 0, "characters": 0},
        }
        job = ("pdfjs", "default", "RB-PDF-12")
        neg = evidence_row(job, CompletedProcess([], 1, json.dumps(result), ""), 1.0, fixture)
        self.assertEqual(neg["status"], "EXPECTED_CAPABILITY_REJECTION")
        self.assertEqual(neg["reasonCode"], "SOURCE_OCR_REQUIRED")
        self.assertIsNone(neg["characters"])
        self.assertNotEqual(neg["status"], "EXECUTION_OK")

        for field, bad in (
            ("failureKind", "PROCESS_FAILURE"),
            ("exitCode", 0),
            ("crashed", True),
            ("timeout", True),
            ("warnings", ["PARSER_ERROR: SOURCE_CORRUPTED"]),
        ):
            item = json.loads(json.dumps(result))
            item["reliability"][field] = bad
            outcome = evidence_row(job, CompletedProcess([], 1, json.dumps(item), ""), 1.0, fixture)
            self.assertEqual(outcome["status"], "NOT_ACCEPTED", field)

        for gate_name, gate_value in (("tempClean", False), ("accepted", True),
                                      ("status", "OK")):
            item = json.loads(json.dumps(result))
            item["benchmarkOutcome"][gate_name] = gate_value
            rejected = evidence_row(job, CompletedProcess([], 1, json.dumps(item), ""), 1.0, fixture)
            self.assertEqual(rejected["status"], "NOT_ACCEPTED", gate_name)
        item = json.loads(json.dumps(result))
        item["reliability"]["warnings"].append("RESULT_PERSIST_FAILED: disk")
        self.assertEqual(evidence_row(job, CompletedProcess([], 1, json.dumps(item), ""), 1.0, fixture)["status"],
                         "NOT_ACCEPTED")
        item = json.loads(json.dumps(result))
        item.pop("benchmarkOutcome")
        self.assertEqual(evidence_row(job, CompletedProcess([], 1, json.dumps(item), ""), 1.0, fixture)["status"],
                         "NOT_ACCEPTED")

        result["document"]["inputSha256"] = "0" * 64
        wrong_source = evidence_row(job, CompletedProcess([], 1, json.dumps(result), ""), 1.0, fixture)
        self.assertEqual(wrong_source["status"], "NOT_ACCEPTED")
        result["document"]["inputSha256"] = fixture["expectedSha256"]
        wrong_parser = evidence_row(("mineru", "flash", "RB-PDF-12"),
                                    CompletedProcess([], 1, json.dumps(result), ""), 1.0, fixture)
        self.assertEqual(wrong_parser["status"], "NOT_ACCEPTED")

    def test_capability_refusal_must_not_mask_healthy_native_success(self):
        fixture = manifest_fixture(self.root, "RB-PDF-11")
        result = {
            "benchmarkOutcome": {"status": "OK", "tempClean": True, "accepted": True},
            "run": {"id": "native"},
            "document": {"inputSha256": fixture["expectedSha256"], "fixtureId": "RB-PDF-11"},
            "reliability": {"exitCode": 0, "crashed": False, "failureKind": None,
                            "timeout": False, "oom": False, "partialOutput": False},
            "extraction": {"extractedPages": 3, "characters": 123},
        }
        row = evidence_row(("liteparse", "default", "RB-PDF-11"),
                           CompletedProcess([], 0, json.dumps(result), ""), 1.0, fixture)
        self.assertEqual(row["status"], "EXECUTION_OK")
        self.assertEqual(row["characters"], 123)



if __name__ == "__main__":
    unittest.main()
