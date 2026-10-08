"""01C contracts: synthetic-only, never uses private books or GPU."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess

from run_real_book_matrix import selected_matrix, manifest_fixture, evidence_row, NATIVE


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
            "run": {"id": "synthetic"},
            "document": {"inputSha256": fixture["expectedSha256"]},
            "reliability": {"exitCode": 0, "crashed": False, "timeout": False,
                            "partialOutput": False, "oom": False},
            "extraction": {"extractedPages": 3, "characters": 42},
        }
        job = ("pdfjs", "default", "RB-PDF-11")
        ok = evidence_row(job, CompletedProcess([], 0, json.dumps(report), ""), 0.12, fixture)
        self.assertEqual(ok["status"], "OK")
        self.assertEqual(ok["extractedPages"], 3)
        self.assertEqual(ok["sourcePages1Based"], [22, 107, 192])

        bad = evidence_row(job, CompletedProcess([], 3, json.dumps(report), ""), 0.12, fixture)
        self.assertEqual(bad["status"], "NOT_ACCEPTED")
        report["document"]["inputSha256"] = "0" * 64
        wrong = evidence_row(job, CompletedProcess([], 0, json.dumps(report), ""), 0.12, fixture)
        self.assertEqual(wrong["status"], "NOT_ACCEPTED")
        missing = evidence_row(job, CompletedProcess([], 0, "not-json", ""), 0.12, fixture)
        self.assertEqual(missing["status"], "NOT_ACCEPTED")


if __name__ == "__main__":
    unittest.main()
