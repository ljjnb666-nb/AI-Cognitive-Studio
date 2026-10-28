"""Synthetic-only private benchmark contract tests; no user's book or OCR text."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "compare_ocr_candidates_offline.py"
spec = importlib.util.spec_from_file_location("acs_private_ocr_comparison", SOURCE)
assert spec and spec.loader
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

SHA = "a" * 64


def source():
    return {
        "pdf": "original.pdf", "sha256": SHA, "size_bytes": 100,
        "page_count": 3, "physical_page_1_based": 2, "book_id": "B03"
    }


def candidate(engine, file):
    return {
        "engine": engine, "revision": "test-v1", "text": file,
        "source_sha256": SHA, "physical_page_1_based": 2
    }


def manifest(reference=None):
    return {
        "schema_version": 1, "source": source(),
        "candidates": [candidate("mineru", "mineru.txt"), candidate("rapidocr", "rapidocr.txt")],
        "reference": reference,
    }


class PrivateOcrCandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "mineru.txt").write_text("ABCDE", encoding="utf-8")
        (self.root / "rapidocr.txt").write_text("ABXDE", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def execute(self, data):
        with patch.object(mod, "validate_source", return_value=source()):
            return mod.compare(self.root, data)

    def test_pairwise_disagreement_not_accuracy_without_approved_gold(self):
        result = self.execute(manifest())
        self.assertEqual(result["pairwise"], [{
            "left": "mineru", "right": "rapidocr", "edit_distance": 1,
            "left_chars": 5, "right_chars": 5,
            "metric": "PAIRWISE_DISAGREEMENT_NOT_CER",
        }])
        self.assertIsNone(result["official_cer"])
        self.assertIsNone(result["engine_ranking"])
        self.assertEqual(result["reference_status"], "NOT_APPROVED")
        self.assertNotIn("ABXDE", json.dumps(result))
        self.assertEqual(result["candidate_lineage"], "DECLARED_NOT_INDEPENDENTLY_ATTESTED")

    def test_partial_visual_draft_never_calculates_cer(self):
        (self.root / "draft.txt").write_text("ABCDE", encoding="utf-8")
        ref = {
            "text": "draft.txt", "source_sha256": SHA, "physical_page_1_based": 2,
            "coverage": "PARTIAL", "review_status": "DRAFT",
            "reviewer_approval_id": "", "independent_review": False,
        }
        result = self.execute(manifest(ref))
        self.assertIsNone(result["official_cer"])
        self.assertNotIn("provisional_cer", result)

    def test_self_attested_full_page_is_only_provisional(self):
        (self.root / "full-page.txt").write_text("ABCDE", encoding="utf-8")
        ref = {
            "text": "full-page.txt", "source_sha256": SHA, "physical_page_1_based": 2,
            "coverage": "FULL_PAGE", "review_status": "APPROVED",
            "reviewer_approval_id": "local-review-001", "independent_review": True,
        }
        result = self.execute(manifest(ref))
        self.assertEqual(result["provisional_cer"], [
            {"engine": "mineru", "character_errors": 0, "reference_chars": 5, "cer": 0.0},
            {"engine": "rapidocr", "character_errors": 1, "reference_chars": 5, "cer": 0.2},
        ])
        self.assertIsNone(result["official_cer"])
        self.assertIsNone(result["engine_ranking"])
        self.assertEqual(result["reference_status"], "DECLARED_APPROVED_NOT_INDEPENDENTLY_VERIFIED")

    def test_reject_cross_source_mixed_physical_page(self):
        wrong = manifest()
        wrong["candidates"][1]["physical_page_1_based"] = 3
        with self.assertRaisesRegex(mod.Blocked, "CANDIDATE_SOURCE_PAGE_MISMATCH"):
            self.execute(wrong)
        wrong = manifest()
        wrong["candidates"][1]["source_sha256"] = "b" * 64
        with self.assertRaisesRegex(mod.Blocked, "CANDIDATE_SOURCE_PAGE_MISMATCH"):
            self.execute(wrong)

    def test_reject_duplicate_engine(self):
        wrong = manifest()
        wrong["candidates"][1]["engine"] = "mineru"
        with self.assertRaisesRegex(mod.Blocked, "DUPLICATE_CANDIDATE_ENGINE"):
            self.execute(wrong)

    def test_reject_symlink_and_traversal(self):
        (self.root / "sub").mkdir()
        link = self.root / "sub" / "external.txt"
        try:
            link.symlink_to(self.root / "mineru.txt")
        except (OSError, NotImplementedError):
            pass
        else:
            with self.assertRaises(mod.Blocked):
                mod.require_relative(self.root, "sub/external.txt")
        for filename in ("../escape.txt", "C:\\private\\other.txt", "/absolute.txt"):
            with self.assertRaises(mod.Blocked):
                mod.require_relative(self.root, filename)

    def test_fail_closed_cli_never_prints_raw_source_or_path(self):
        secret = "SECRET_PRIVATE_TEXT_SENTINEL"
        (self.root / "manifest.json").write_text(json.dumps(manifest()), encoding="utf-8")
        with patch.object(mod, "compare", side_effect=RuntimeError(secret)):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = mod.main(["--root", str(self.root), "--manifest", "manifest.json"])
        self.assertEqual(code, 2)
        self.assertNotIn(secret, output.getvalue())
        self.assertNotIn(str(self.root), output.getvalue())
        self.assertIn('"official_cer": null'.replace(" ", ""), output.getvalue())

    def test_distance_true_levenshtein_not_similarity(self):
        self.assertEqual(mod.distance("","abc"), 3)
        self.assertEqual(mod.distance("kitten", "sitting"), 3)
        self.assertEqual(mod.distance("ABCD", "ACBD"), 2)

    def test_reject_overlong_page_before_quadratic_comparison(self):
        (self.root / "rapidocr.txt").write_text("X" * (mod.MAX_PAGE_CHARS + 1), encoding="utf-8")
        with self.assertRaisesRegex(mod.Blocked, "CANDIDATE_TEXT_INVALID"):
            self.execute(manifest())


if __name__ == "__main__":
    unittest.main()
