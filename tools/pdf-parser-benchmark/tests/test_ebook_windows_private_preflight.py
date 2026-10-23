"""Synthetic streaming SHA and private sidecar preflight tests (no real books)."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ebook_windows_private_preflight import PreflightError, _digest, main, preflight

DATA = {
    "B15": b"%PDF-1.7\nsynthetic page B15\n",
    "B16": b"%PDF-1.7\nsynthetic page B16\n",
    "B31": b"%PDF-1.7\nsynthetic page B31\n",
}
MANIFEST = {"sources": [
    {"id": name, "sha256": hashlib.sha256(payload).hexdigest(), "size": len(payload)}
    for name, payload in DATA.items()
]}


class PrivatePreflight(unittest.TestCase):
    def _root(self, path):
        (path / "first.pdf").write_bytes(DATA["B15"])
        (path / "second.PDF").write_bytes(DATA["B16"])
        with zipfile.ZipFile(path / "ebooks.zip", "w") as archive:
            archive.writestr("books/B31.pdf", DATA["B31"])

    def test_streamed_plain_and_zipped_pdf_matching(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._root(root)
            result = preflight(root, MANIFEST)
            self.assertEqual(result["corpus_present"], 3)
            self.assertEqual(result["missing_book_ids"], [])
            self.assertEqual(result["private_roi_status"], "ABSENT")
            self.assertEqual(result["private_calibration_status"], "ABSENT")
            self.assertEqual(result["real_spatial_accuracy"], "UNVERIFIED")

    def test_missing_book_does_not_count_as_incorrect_ocr(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "one.pdf").write_bytes(DATA["B15"])
            result = preflight(root, MANIFEST)
            self.assertEqual(result["corpus_present"], 1)
            self.assertEqual(result["missing_book_ids"], ["B16", "B31"])
            self.assertEqual(result["graph_semantics"], "UNVERIFIED")

    def test_duplicate_file_does_not_inflate_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._root(root)
            (root / "copy.pdf").write_bytes(DATA["B15"])
            self.assertEqual(preflight(root, MANIFEST)["corpus_present"], 3)

    def test_private_l2_sidecar_presence_not_truth(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._root(root)
            folder = root / "semantic_gate"
            folder.mkdir()
            (folder / "B15_B31_roi_candidates.private.json").write_text(
                json.dumps({"authority": "L2_AI_VISUAL_PROVISIONAL_NOT_HUMAN_GROUND_TRUTH", "regions": []}),
                encoding="utf-8",
            )
            (folder / "B15_roi_frame_calibration.private.json").write_text(
                json.dumps({"authority": "PRIVATE_AI_VISUAL_L2_FRAME_CALIBRATION_NOT_GROUND_TRUTH",
                            "book_id": "B15", "physical_page": 109,
                            "source_document_sha256": MANIFEST["sources"][0]["sha256"],
                            "source_pdf_rotation_degrees": 270}), encoding="utf-8",
            )
            result = preflight(root, MANIFEST)
            self.assertEqual(result["private_roi_status"], "PRESENT_NOT_ACCURACY_VERIFIED")
            self.assertEqual(result["private_calibration_status"], "PRESENT_NOT_GEOMETRY_VERIFIED")

    def test_sidecar_claims_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._root(root)
            folder = root / "semantic_gate"
            folder.mkdir()
            sidecar = folder / "B15_B31_roi_candidates.private.json"
            sidecar.write_text('{"authority": "HUMAN_GOLD"}', encoding="utf-8")
            with self.assertRaisesRegex(PreflightError, "PRIVATE_ROI_AUTHORITY_INVALID"):
                preflight(root, MANIFEST)

    def test_sidecar_cross_book_sha_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._root(root)
            folder = root / "semantic_gate"
            folder.mkdir()
            (folder / "B15_roi_frame_calibration.private.json").write_text(json.dumps({
                "authority": "PRIVATE_AI_VISUAL_L2_FRAME_CALIBRATION_NOT_GROUND_TRUTH",
                "book_id": "B15", "physical_page": 109,
                "source_document_sha256": "0"*64,
                "source_pdf_rotation_degrees": 270,
            }), encoding="utf-8")
            with self.assertRaisesRegex(PreflightError, "PRIVATE_CALIBRATION_PROVENANCE_INVALID"):
                preflight(root, MANIFEST)

    def test_digest_bytes_bound_enforced(self):
        with self.assertRaisesRegex(PreflightError, "PRIVATE_PDF_SIZE_OVER_LIMIT"):
            _digest(io.BytesIO(DATA["B15"]), max_bytes=5)

    def test_invalid_manifest_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(PreflightError, "CORPUS_TARGETS_MISSING"):
                preflight(Path(directory), {"sources": MANIFEST["sources"][:1]})

    def test_main_reports_only_anonymous_status(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self._root(root)
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps(MANIFEST), encoding="utf-8")
            original_stdout = sys.stdout
            stdout = io.StringIO()
            try:
                sys.stdout = stdout
                self.assertEqual(main(["--root", directory, "--manifest", str(manifest)]), 0)
            finally:
                sys.stdout = original_stdout
            value = stdout.getvalue()
            self.assertIn("ACS_PRIVATE_PREFLIGHT_SHA_MATCHED=3", value)
            self.assertNotIn(MANIFEST["sources"][0]["sha256"], value)
            self.assertNotIn("synthetic page", value)


if __name__ == "__main__":
    unittest.main()
