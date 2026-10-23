"""No private books, no provider, no network. Synthetic-only ledger tests."""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ebook_private_graph_receipt_audit import (
    AuditError, PREFIX, MARKER_STATUS, audit, main, private_json,
)

SHA = {"B15": "a" * 64, "B31": "b" * 64}
PAGES = {"B15": 109, "B31": 126}
MANIFEST = {"sources": [
    {"id": name, "size": 128, "sha256": digest,
     "total_physical_pages": 500}
    for name, digest in SHA.items()
]}


def marker(book):
    return {
        "status": MARKER_STATUS, "source_document_sha256": SHA[book],
        "physical_page": PAGES[book], "model": "glm-4.6v", "provider": "GLM",
    }


def candidate(book, *, abstain=False):
    obj = {
        "schema_version": 1,
        "page": {"book_id": book, "physical_page": PAGES[book],
                 "source_document_sha256": SHA[book]},
        "engine": {"name": "glm_visual_proposal", "version": "glm-4.6v"},
        "objects": [] if abstain else [{"role": "chart_a", "kind": "chart"}],
        "relations": [], "axes": [], "trends": [], "abstained": abstain,
    }
    return obj


class PrivateReceiptAudit(unittest.TestCase):
    def folder(self, root):
        folder = root / "semantic_gate"
        folder.mkdir(exist_ok=True)
        return folder

    def put(self, folder, book, kind, value):
        f = folder / (PREFIX + book + "." + kind + ".private.json")
        f.write_text(json.dumps(value), encoding="utf-8")
        return f

    def test_without_attempts_both_not_started(self):
        with tempfile.TemporaryDirectory() as t:
            self.assertEqual(audit(Path(t), MANIFEST),
                             {"B15": "NOT_STARTED", "B31": "NOT_STARTED"})

    def test_b15_marker_only_stays_quarantined_and_b31_unstarted(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            folder = self.folder(root)
            m = self.put(folder, "B15", "request", marker("B15"))
            before = m.read_bytes()
            self.assertEqual(audit(root, MANIFEST),
                             {"B15": "QUARANTINED_PAID_OUTCOME_UNKNOWN",
                              "B31": "NOT_STARTED"})
            self.assertEqual(m.read_bytes(), before)
            self.assertFalse((folder / (PREFIX + "B15.candidate.private.json")).exists())

    def test_valid_candidate_is_provisional_never_gold(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            folder = self.folder(root)
            self.put(folder, "B15", "request", marker("B15"))
            self.put(folder, "B15", "candidate", candidate("B15"))
            self.put(folder, "B31", "request", marker("B31"))
            self.put(folder, "B31", "candidate", candidate("B31", abstain=True))
            result = audit(root, MANIFEST)
            self.assertEqual(result["B15"], "PRIVATE_CANDIDATE_PRESENT_UNCERTIFIED")
            self.assertEqual(result["B31"], "PRIVATE_ABSTENTION_UNCERTIFIED")

    def test_wrong_marker_identity_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            folder = self.folder(root)
            bad = marker("B15")
            bad["source_document_sha256"] = SHA["B31"]
            self.put(folder, "B15", "request", bad)
            with self.assertRaisesRegex(AuditError, "REQUEST_MARKER_IDENTITY_INVALID"):
                audit(root, MANIFEST)

    def test_orphan_candidate_is_not_accepted(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            folder = self.folder(root)
            self.put(folder, "B15", "candidate", candidate("B15"))
            with self.assertRaisesRegex(AuditError, "ORPHAN_CANDIDATE"):
                audit(root, MANIFEST)

    def test_candidate_cross_page_and_fake_gold_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            folder = self.folder(root)
            self.put(folder, "B15", "request", marker("B15"))
            c = candidate("B15")
            c["page"]["physical_page"] = 126
            f = self.put(folder, "B15", "candidate", c)
            with self.assertRaisesRegex(AuditError, "CANDIDATE_PAGE_IDENTITY_INVALID"):
                audit(root, MANIFEST)
            c = candidate("B15")
            c["humanVerified"] = True
            f.write_text(json.dumps(c), encoding="utf-8")
            with self.assertRaisesRegex(AuditError, "CANDIDATE_UNAUTHORIZED_VERIFICATION_CLAIM"):
                audit(root, MANIFEST)

    def test_duplicate_json_keys_and_oversized_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            folder = self.folder(root)
            f = folder / (PREFIX + "B15.request.private.json")
            f.write_text('{"status":"x","status":"y"}', encoding="utf-8")
            with self.assertRaisesRegex(AuditError, "DUPLICATE_JSON_KEY"):
                audit(root, MANIFEST)
            f.write_bytes(b"x" * 65537)
            with self.assertRaisesRegex(AuditError, "PRIVATE_RECORD_SIZE_INVALID"):
                audit(root, MANIFEST)

    def test_symlink_not_followed(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            folder = self.folder(root)
            actual = root / "external.json"
            actual.write_text(json.dumps(marker("B15")), encoding="utf-8")
            link = folder / (PREFIX + "B15.request.private.json")
            try:
                link.symlink_to(actual)
            except (OSError, NotImplementedError):
                self.skipTest("symlink permissions not available")
            with self.assertRaisesRegex(AuditError, "PRIVATE_RECORD_UNSAFE"):
                audit(root, MANIFEST)

    def test_missing_manifest_target_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            with self.assertRaisesRegex(AuditError, "MANIFEST_TARGET_MISSING"):
                audit(Path(t), {"sources": MANIFEST["sources"][:1]})

    def test_cli_prints_only_anonymous_status_and_no_private_sha(self):
        with tempfile.TemporaryDirectory() as t:
            root = Path(t)
            folder = self.folder(root)
            self.put(folder, "B15", "request", marker("B15"))
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps(MANIFEST), encoding="utf-8")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                self.assertEqual(main(["--private-root", str(root),
                                       "--manifest", str(manifest)]), 0)
            out = buf.getvalue()
            self.assertIn("B15|STATUS=QUARANTINED_PAID_OUTCOME_UNKNOWN", out)
            self.assertIn("ACS_GRAPH_NEW_PROVIDER_CALLS=0", out)
            self.assertNotIn(SHA["B15"], out)
            self.assertNotIn(str(root), out)


if __name__ == "__main__":
    unittest.main()
