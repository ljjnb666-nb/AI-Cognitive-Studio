"""Private-fixture intake regressions, using synthetic bytes only."""
import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from import_private_real_books import run


class PrivateFixtureImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fixtures = self.root / "fixtures"
        self.fixtures.mkdir()
        self.manifest = self.fixtures / "fixtures.manifest.json"
        self.manifest.write_text(json.dumps({"fixtures": [
            {"id": "F1-native-cn", "filename": "F1-native-cn.pdf", "fixtureClass": "synthetic",
             "generator": "test", "declaredPages": 1, "notes": "synthetic"},
        ]}))
        self.archive = self.root / "books.zip"
        self.selection = self.root / "private-selection.json"
        self.data = b"%PDF-1.4\nSynthetic only\n" * 25
        self.record = {
            "id": "RB-PDF-01", "format": "pdf", "priority": "P0",
            "archive_member": "source.pdf", "bytes": len(self.data),
            "sha256": hashlib.sha256(self.data).hexdigest(), "pages": 2,
        }
        self.reset_inputs()

    def reset_inputs(self):
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr("source.pdf", self.data)
        self.selection.write_text(json.dumps({
            "schema_version": "acs-real-book-fixtures-v1", "selection": [self.record],
        }))

    def test_dry_run_hashes_contents_without_writes(self):
        result = run(self.archive, self.selection, self.fixtures, "P0", True)
        self.assertEqual(result["status"], "DRY_RUN_PASS")
        self.assertFalse((self.fixtures / "RB-PDF-01.pdf").exists())
        self.assertEqual(len(json.loads(self.manifest.read_text())["fixtures"]), 1)

    def test_install_is_idempotent_and_records_expected_hash(self):
        first = run(self.archive, self.selection, self.fixtures, "P0", False)
        second = run(self.archive, self.selection, self.fixtures, "P0", False)
        self.assertEqual((first["installed"], first["manifest_additions"]), (1, 1))
        self.assertEqual((second["installed"], second["manifest_additions"]), (0, 0))
        entries = json.loads(self.manifest.read_text())["fixtures"]
        self.assertEqual([e["id"] for e in entries], ["F1-native-cn", "RB-PDF-01"])
        self.assertEqual(entries[-1]["expectedSha256"], self.record["sha256"])
        self.assertEqual(entries[-1]["declaredBytes"], len(self.data))

    def test_tampered_archive_fails_dry_run(self):
        self.data = b"%PDF-1.4\nTAMPERED ONLY\n" * 25
        self.reset_inputs()
        with self.assertRaisesRegex(ValueError, "ZIP_SIZE_MISMATCH|ZIP_SHA256_MISMATCH"):
            run(self.archive, self.selection, self.fixtures, "P0", True)
        self.assertFalse((self.fixtures / "RB-PDF-01.pdf").exists())

    def test_existing_file_mismatch_rejected(self):
        (self.fixtures / "RB-PDF-01.pdf").write_bytes(b"corrupted")
        with self.assertRaisesRegex(ValueError, "EXISTING_FIXTURE_CHANGED"):
            run(self.archive, self.selection, self.fixtures, "P0", False)
        self.assertEqual(len(json.loads(self.manifest.read_text())["fixtures"]), 1)

    def test_manifest_collision_rejected(self):
        data = json.loads(self.manifest.read_text())
        data["fixtures"].append({"id": "RB-PDF-01", "filename": "other.pdf"})
        self.manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "FIXTURE_ID_CONFLICT"):
            run(self.archive, self.selection, self.fixtures, "P0", False)

    def test_zip_path_traversal_rejected(self):
        self.record["archive_member"] = "../source.pdf"
        self.reset_inputs()
        with self.assertRaisesRegex(ValueError, "ARCHIVE_MEMBER_PATH_INVALID"):
            run(self.archive, self.selection, self.fixtures, "P0", True)

    def test_reserved_lock_prevents_modification(self):
        (self.fixtures / ".real-book-import.lock").write_text("held")
        with self.assertRaises(FileExistsError):
            run(self.archive, self.selection, self.fixtures, "P0", False)
        self.assertFalse((self.fixtures / "RB-PDF-01.pdf").exists())

    def test_preexisting_partial_preserved(self):
        part = self.fixtures / "RB-PDF-01.pdf.part"
        part.write_bytes(b"preexisting")
        with self.assertRaises(FileExistsError):
            run(self.archive, self.selection, self.fixtures, "P0", False)
        self.assertEqual(part.read_bytes(), b"preexisting")

    def test_preexisting_manifest_partial_preserved(self):
        part = self.fixtures / "fixtures.manifest.json.part"
        part.write_bytes(b"previous interrupted transaction")
        with self.assertRaises(FileExistsError):
            run(self.archive, self.selection, self.fixtures, "P0", False)
        self.assertEqual(part.read_bytes(), b"previous interrupted transaction")
        self.assertEqual(len(json.loads(self.manifest.read_text())["fixtures"]), 1)

    def test_manifest_symlink_rejected(self):
        self.manifest.unlink()
        self.manifest.symlink_to(self.root / "other.json")
        with self.assertRaisesRegex(ValueError, "FIXTURE_MANIFEST_NOT_REGULAR_FILE"):
            run(self.archive, self.selection, self.fixtures, "P0", False)


if __name__ == "__main__":
    unittest.main()
