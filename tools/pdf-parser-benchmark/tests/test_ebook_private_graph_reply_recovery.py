"""Pure synthetic private GLM reply custody, fail-closed recovery tests."""
import copy
import hashlib
import io
import json
import contextlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ebook_private_graph_reply_recovery import (
    capture_reply, offline_recover, strict_payload, main, VisualGateError,
)
from ebook_private_visual_graph_proposal import run
from ebook_private_graph_receipt_audit import MARKER_STATUS

SOURCE = {"B15": b"synthetic-page-b15", "B31": b"synthetic-page-b31"}
ROWS = {book: {"id": book, "size": len(raw),
               "sha256": hashlib.sha256(raw).hexdigest(),
               "total_physical_pages": 600}
        for book, raw in SOURCE.items()}
MANIFEST = {"sources": list(ROWS.values())}
CHART = {
    "objects": [{"role": "plot", "kind": "chart"},
                {"role": "curve_a", "kind": "series", "parent_role": "plot"}],
    "relations": [],
    "axes": [{"chart_role": "plot", "dimension": "x", "meaning": "time"}],
    "trends": [{"chart_role": "plot", "series_role": "curve_a", "shape": "increasing"}],
    "abstained": False,
}
NETWORK = {
    "objects": [{"role": "client", "kind": "node"},
                {"role": "server", "kind": "node"}],
    "relations": [{"source_role": "client", "target_role": "server",
                   "relation": "connects_to", "directed": True}],
    "axes": [], "trends": [], "abstained": False,
}


def fence(obj):
    return chr(96)*3 + "json\n" + json.dumps(obj) + "\n" + chr(96)*3


def seed(root, book):
    folder = root / "semantic_gate"
    folder.mkdir(exist_ok=True)
    marker = {
        "status": MARKER_STATUS,
        "source_document_sha256": ROWS[book]["sha256"],
        "physical_page": 109 if book == "B15" else 126,
        "model": "glm-4.6v", "provider": "GLM",
    }
    path = folder / ("visual_graph_proposal_" + book + ".request.private.json")
    path.write_text(json.dumps(marker), encoding="utf-8")
    return path


class FakeResponse:
    status_code = 200

    def __init__(self, content, finish_reason="stop"):
        self.content = content
        self.finish_reason = finish_reason

    def json(self):
        return {"choices": [{"message": {"content": self.content},
                             "finish_reason": self.finish_reason}]}


class FakeRequests:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = 0

    def post(self, *args, **kwargs):
        self.calls += 1
        reply = self.replies.pop(0)
        if isinstance(reply, tuple):
            return FakeResponse(*reply)
        return FakeResponse(reply)


def render(raw, page, fitz):
    return b"synthetic-image", 270 if page == 109 else 0, (800, 800)


class OfflineReplyRecovery(unittest.TestCase):
    def test_fenced_json_exact_only(self):
        self.assertEqual(strict_payload(fence(CHART)), CHART)
        self.assertEqual(strict_payload(json.dumps(CHART)), CHART)
        for bad in ["prefix\n" + fence(CHART),
                    fence(CHART) + "\nexplanation",
                    json.dumps(CHART) + " trailing explanation",
                    "{} {}"]:
            with self.subTest(bad=bad[:15]):
                with self.assertRaisesRegex(VisualGateError, "STRUCTURE_MODEL_JSON_INVALID"):
                    strict_payload(bad)

    def test_duplicate_keys_and_nan_rejected(self):
        with self.assertRaisesRegex(VisualGateError, "STRUCTURE_MODEL_JSON_INVALID"):
            strict_payload('{"objects":[],"objects":[]}')
        with self.assertRaisesRegex(VisualGateError, "STRUCTURE_MODEL_JSON_INVALID"):
            strict_payload('{"objects":NaN}')
        with self.assertRaisesRegex(VisualGateError, "STRUCTURE_MODEL_SCHEMA_INVALID"):
            strict_payload('[]')

    def test_legacy_marker_does_not_invent_previous_reply(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            seed(root, "B15")
            self.assertEqual(offline_recover(root, MANIFEST, "B15"),
                             "NO_CAPTURED_REPLY_LEGACY_ATTEMPT")
            with self.assertRaisesRegex(VisualGateError, "NO_CAPTURED_REPLY_NO_RECOVERY"):
                offline_recover(root, MANIFEST, "B15", write_candidate=True)

    def test_snapshot_capture_integrity_and_offline_recovery(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            seed(root, "B15")
            reply = fence(CHART)
            snapshot = capture_reply(root, "B15", ROWS["B15"]["sha256"], reply, finish_reason="stop")
            raw_saved = snapshot.read_bytes()
            self.assertEqual(offline_recover(root, MANIFEST, "B15"),
                             "RECOVERABLE_OFFLINE_NO_WRITE")
            self.assertFalse((root / "semantic_gate" /
                              "visual_graph_proposal_B15.candidate.private.json").exists())
            with contextlib.redirect_stdout(io.StringIO()) as buff:
                self.assertEqual(main(["--private-root", str(root),
                                       "--manifest", self._manifest(root),
                                       "--book", "B15"]), 0)
            self.assertNotIn(reply, buff.getvalue())
            self.assertNotIn(ROWS["B15"]["sha256"], buff.getvalue())
            self.assertEqual(snapshot.read_bytes(), raw_saved)
            self.assertEqual(offline_recover(root, MANIFEST, "B15",
                                             write_candidate=True),
                             "PRIVATE_CANDIDATE_RECOVERED_UNCERTIFIED")
            candidate = root / "semantic_gate" / "visual_graph_proposal_B15.candidate.private.json"
            self.assertEqual(json.loads(candidate.read_text())["trends"], CHART["trends"])
            with self.assertRaisesRegex(VisualGateError, "CANDIDATE_ALREADY_EXISTS_NO_OVERWRITE"):
                offline_recover(root, MANIFEST, "B15", write_candidate=True)
            self.assertEqual(snapshot.read_bytes(), raw_saved)

    def _manifest(self, root):
        path = root / "synthetic-manifest.json"
        path.write_text(json.dumps(MANIFEST), encoding="utf-8")
        return str(path)

    def test_capture_requires_marker_and_correct_sha(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "semantic_gate").mkdir()
            with self.assertRaisesRegex(VisualGateError, "REQUEST_MARKER_REQUIRED"):
                capture_reply(root, "B15", ROWS["B15"]["sha256"], "{}")
            seed(root, "B15")
            with self.assertRaisesRegex(VisualGateError, "REQUEST_MARKER_IDENTITY_INVALID"):
                capture_reply(root, "B15", ROWS["B31"]["sha256"], "{}")

    def test_capture_is_exclusive_and_snapshot_tamper_detected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            seed(root, "B15")
            reply = json.dumps(CHART)
            path = capture_reply(root, "B15", ROWS["B15"]["sha256"], reply)
            with self.assertRaises(FileExistsError):
                capture_reply(root, "B15", ROWS["B15"]["sha256"], reply)
            before = json.loads(path.read_text(encoding="utf-8"))
            before["reply_sha256"] = "f" * 64
            path.write_text(json.dumps(before), encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError, "REPLY_CUSTODY_INTEGRITY_INVALID"):
                offline_recover(root, MANIFEST, "B15")

    def test_captured_invalid_reply_survives_parse_failure_with_no_retry(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            bad = "PRIVATE_SYNTHETIC_MODEL_REPLY: not JSON"
            fake = FakeRequests([bad])
            with patch("ebook_private_visual_graph_proposal._raw_sources",
                       return_value=iter(SOURCE.items())), patch(
                       "ebook_private_visual_graph_proposal.render_page", side_effect=render):
                with self.assertRaisesRegex(VisualGateError, "STRUCTURE_MODEL_JSON_INVALID"):
                    run(MANIFEST, root, "synthetic_fake_key_not_real", fitz=None,
                        requests_module=fake, allow_cloud=True)
                self.assertEqual(fake.calls, 1)
                path = root / "semantic_gate" / "visual_graph_proposal_B15.reply.private.json"
                self.assertIn(bad, path.read_text(encoding="utf-8"))
                with self.assertRaisesRegex(VisualGateError, "STRUCTURE_MODEL_JSON_INVALID"):
                    offline_recover(root, MANIFEST, "B15")
                with self.assertRaisesRegex(VisualGateError,
                                            "PAID_REQUEST_ALREADY_STARTED_NO_AUTO_RETRY"):
                    run(MANIFEST, root, "synthetic_fake_key_not_real", fitz=None,
                        requests_module=fake, allow_cloud=True)
                self.assertEqual(fake.calls, 1)
                self.assertFalse((root / "semantic_gate" /
                                  "visual_graph_proposal_B31.request.private.json").exists())

    def test_offline_custody_wrong_page_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            seed(root, "B15")
            path = capture_reply(root, "B15", ROWS["B15"]["sha256"], json.dumps(CHART))
            data = json.loads(path.read_text(encoding="utf-8"))
            data["physical_page"] = 126
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError, "REPLY_CUSTODY_INTEGRITY_INVALID"):
                offline_recover(root, MANIFEST, "B15")

    def test_non_utf8_or_oversized_reply_rejected(self):
        with self.assertRaisesRegex(VisualGateError, "STRUCTURE_MODEL_REPLY_SIZE_INVALID"):
            strict_payload("a" * 32769)

    def test_truncated_paid_response_is_saved_but_never_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            fake = FakeRequests([(json.dumps(CHART), "length")])
            with patch("ebook_private_visual_graph_proposal._raw_sources",
                       return_value=iter(SOURCE.items())), patch(
                       "ebook_private_visual_graph_proposal.render_page", side_effect=render):
                with self.assertRaisesRegex(VisualGateError, "REPLY_COMPLETION_NOT_FINAL"):
                    run(MANIFEST, root, "synthetic_fake_key_not_real",
                        fitz=None, requests_module=fake, allow_cloud=True)
                self.assertEqual(fake.calls, 1)
                folder = root / "semantic_gate"
                snapshot = folder / "visual_graph_proposal_B15.reply.private.json"
                self.assertEqual(json.loads(snapshot.read_text())["finish_reason"], "length")
                self.assertFalse((folder / "visual_graph_proposal_B15.candidate.private.json").exists())
                with self.assertRaisesRegex(VisualGateError, "REPLY_COMPLETION_NOT_FINAL"):
                    offline_recover(root, MANIFEST, "B15")
                with self.assertRaisesRegex(VisualGateError, "PAID_REQUEST_ALREADY_STARTED_NO_AUTO_RETRY"):
                    run(MANIFEST, root, "synthetic_fake_key_not_real",
                        fitz=None, requests_module=fake, allow_cloud=True)
                self.assertEqual(fake.calls, 1)

    def test_missing_finish_reason_is_unknown_and_not_candidate(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            fake = FakeRequests([(json.dumps(CHART), None)])
            with patch("ebook_private_visual_graph_proposal._raw_sources",
                       return_value=iter(SOURCE.items())), patch(
                       "ebook_private_visual_graph_proposal.render_page", side_effect=render):
                with self.assertRaisesRegex(VisualGateError, "REPLY_COMPLETION_NOT_FINAL"):
                    run(MANIFEST, root, "synthetic_fake_key_not_real",
                        fitz=None, requests_module=fake, allow_cloud=True)
            self.assertEqual(fake.calls, 1)
            captured = json.loads((root/"semantic_gate"/
                "visual_graph_proposal_B15.reply.private.json").read_text())
            self.assertEqual(captured["finish_reason"], "unknown")

    def test_tampered_finish_reason_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            seed(root, "B15")
            p = capture_reply(root, "B15", ROWS["B15"]["sha256"],
                              json.dumps(CHART), finish_reason="stop")
            value = json.loads(p.read_text())
            value["finish_reason"] = "anything_else"
            p.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError, "REPLY_CUSTODY_INTEGRITY_INVALID"):
                offline_recover(root, MANIFEST, "B15")

    def test_candidate_b31_supported(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            seed(root, "B31")
            capture_reply(root, "B31", ROWS["B31"]["sha256"], json.dumps(NETWORK), finish_reason="stop")
            self.assertEqual(offline_recover(root, MANIFEST, "B31"),
                             "RECOVERABLE_OFFLINE_NO_WRITE")


if __name__ == "__main__":
    unittest.main()
