"""Deterministic synthetic-only regression tests for the private page-subset builder."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from make_real_page_subsets import PLANS, run


class PageSubsetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "fixtures"
        self.root.mkdir()
        self.manifest = self.root / "fixtures.manifest.json"
        writer = PdfWriter()
        for i in range(1, 401):
            writer.add_blank_page(width=200 + i, height=300 + i)
        source = self.root / "RB-PDF-01.pdf"
        with source.open("wb") as f:
            writer.write(f)
        self.source_size = source.stat().st_size
        self.source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        rows = [
            {"id": "RB-PDF-01", "filename": "RB-PDF-01.pdf", "expectedSha256": self.source_hash,
             "declaredBytes": self.source_size, "declaredPages": 400, "fixtureClass": "private-real-book"},
        ]
        self.manifest.write_text(json.dumps({"fixtures": rows}), "utf-8")

    def test_dry_run_is_read_only(self):
        result = run(self.root, ["RB-PDF-11"], dry_run=True)
        self.assertEqual(result["status"], "DRY_RUN_PASS")
        self.assertFalse((self.root / "RB-PDF-11.pdf").exists())
        self.assertEqual(len(json.loads(self.manifest.read_text())["fixtures"]), 1)

    def test_exact_page_map_and_lineage_are_recorded(self):
        first = run(self.root, ["RB-PDF-11"])
        second = run(self.root, ["RB-PDF-11"])
        self.assertEqual((first["created"], first["manifestAdditions"]), (1, 1))
        self.assertEqual((second["created"], second["manifestAdditions"]), (0, 0))
        rows = json.loads(self.manifest.read_text())["fixtures"]
        sub = rows[1]
        self.assertEqual(sub["sourcePages1Based"], [22, 107, 192])
        self.assertEqual(sub["sourceSha256"], self.source_hash)
        self.assertEqual(sub["declaredPages"], 3)
        self.assertEqual(sub["expectedSha256"], hashlib.sha256((self.root / "RB-PDF-11.pdf").read_bytes()).hexdigest())
        with (self.root / "RB-PDF-11.pdf").open("rb") as f:
            reader = PdfReader(f)
            self.assertEqual([int(p.mediabox.width) for p in reader.pages], [222, 307, 392])

    def test_mutated_source_fails_before_writing(self):
        p = self.root / "RB-PDF-01.pdf"
        with p.open("ab") as f:
            f.write(b"tampered")
        with self.assertRaisesRegex(ValueError, "SOURCE_IDENTITY_MISMATCH"):
            run(self.root, ["RB-PDF-11"])
        self.assertFalse((self.root / "RB-PDF-11.pdf").exists())

    def test_declared_page_count_must_match(self):
        o = json.loads(self.manifest.read_text())
        o["fixtures"][0]["declaredPages"] = 399
        self.manifest.write_text(json.dumps(o))
        with self.assertRaisesRegex(ValueError, "SOURCE_PAGE_RANGE_MISMATCH"):
            run(self.root, ["RB-PDF-11"])

    def test_preexisting_unregistered_output_fail_closed(self):
        (self.root / "RB-PDF-11.pdf").write_bytes(b"stray")
        with self.assertRaisesRegex(ValueError, "SUBSET_MANIFEST_FILE_DRIFT"):
            run(self.root, ["RB-PDF-11"])
        self.assertEqual((self.root / "RB-PDF-11.pdf").read_bytes(), b"stray")

    def test_registered_subset_cannot_be_swapped(self):
        run(self.root, ["RB-PDF-11"])
        (self.root / "RB-PDF-11.pdf").write_bytes(b"altered")
        with self.assertRaisesRegex(ValueError, "EXISTING_SUBSET_CONFLICT"):
            run(self.root, ["RB-PDF-11"])

    def test_staging_unlink_failure_rolls_back(self):
        original = Path.unlink
        triggered = {"value": False}

        def injected(path, *args, **kwargs):
            if path.name == "RB-PDF-11.pdf.part" and not triggered["value"]:
                triggered["value"] = True
                raise OSError("injected unlink failure")
            return original(path, *args, **kwargs)

        with patch.object(Path, "unlink", injected):
            with self.assertRaisesRegex(OSError, "injected unlink failure"):
                run(self.root, ["RB-PDF-11"])
        self.assertTrue(triggered["value"])
        self.assertFalse((self.root / "RB-PDF-11.pdf").exists())
        self.assertFalse((self.root / "RB-PDF-11.pdf.part").exists())
        self.assertFalse((self.root / ".real-subset.lock").exists())
        self.assertEqual(len(json.loads(self.manifest.read_text())["fixtures"]), 1)

    def test_preexisting_partial_not_deleted(self):
        part = self.root / "RB-PDF-11.pdf.part"
        part.write_bytes(b"stale recovery evidence")
        with self.assertRaises(FileExistsError):
            run(self.root, ["RB-PDF-11"])
        self.assertEqual(part.read_bytes(), b"stale recovery evidence")

    def test_preexisting_manifest_partial_not_deleted(self):
        part = self.root / "fixtures.manifest.json.part"
        part.write_bytes(b"existing")
        with self.assertRaises(FileExistsError):
            run(self.root, ["RB-PDF-11"])
        self.assertEqual(part.read_bytes(), b"existing")

    def test_invalid_target_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "INVALID_TARGET_SET"):
            run(self.root, ["RB-PDF-11", "RB-PDF-11"])
        with self.assertRaisesRegex(ValueError, "INVALID_TARGET_SET"):
            run(self.root, ["RB-PDF-99"])


if __name__ == "__main__":
    unittest.main()
