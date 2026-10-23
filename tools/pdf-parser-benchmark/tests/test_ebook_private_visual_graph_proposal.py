"""Synthetic-only tests: fake page pixels and fake provider, never user's books."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ebook_private_visual_graph_proposal import (
    FILE_PREFIX, VisualGateError, build_prompt, parse_candidate, prepare,
    request_structure, run,
)

B15 = {
    "objects": [
        {"role": "plot", "kind": "chart"},
        {"role": "curve_a", "kind": "series", "parent_role": "plot"},
        {"role": "curve_b", "kind": "series", "parent_role": "plot"},
    ],
    "relations": [],
    "axes": [{"chart_role": "plot", "dimension": "x", "meaning": "time"}],
    "trends": [
        {"chart_role": "plot", "series_role": "curve_a", "shape": "increasing"},
        {"chart_role": "plot", "series_role": "curve_b", "shape": "decreasing"},
    ],
    "abstained": False,
}
B31 = {
    "objects": [
        {"role": "client", "kind": "process"},
        {"role": "server", "kind": "process"},
    ],
    "relations": [
        {"source_role": "client", "target_role": "server",
         "relation": "connects_to", "directed": True},
    ],
    "axes": [], "trends": [], "abstained": False,
}
RAW = {"B15": b"synthetic B15 PDF bytes", "B31": b"synthetic B31 PDF bytes"}
SELECTED = {
    k: {"id": k, "size": len(v), "sha256": hashlib.sha256(v).hexdigest(),
        "total_physical_pages": 438} for k, v in RAW.items()
}
MANIFEST = {"sources": list(SELECTED.values())}
ABSTAINED = {"objects": [], "relations": [], "axes": [],
             "trends": [], "abstained": True}


class FakeResponse:
    status_code = 200

    def __init__(self, data):
        self.data = data

    def json(self):
        return {"choices": [{"message": {"content": json.dumps(self.data)}}]}


class FakeRequests:
    def __init__(self, answers=None, error=None):
        self.answers = iter(answers or [])
        self.error = error
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.error:
            raise RuntimeError("synthetic transport exception with secret")
        return FakeResponse(next(self.answers))


def fake_render(raw, page, fitz):
    return b"synthetic image bytes", 270 if page == 109 else 0, (1600, 900)


class PrivateGraphProposal(unittest.TestCase):
    def test_b15_multiseries_and_b31_directed_edge(self):
        a = parse_candidate(json.dumps(B15), "B15", SELECTED["B15"])
        b = parse_candidate(json.dumps(B31), "B31", SELECTED["B31"])
        self.assertEqual(len(a["trends"]), 2)
        self.assertEqual(b["relations"][0]["target_role"], "server")
        self.assertEqual(a["page"]["source_document_sha256"], SELECTED["B15"]["sha256"])

    def test_full_run_makes_exactly_two_single_attempt_cloud_calls(self):
        with tempfile.TemporaryDirectory() as t:
            folder = Path(t)
            fake = FakeRequests([B15, B31])
            with patch("ebook_private_visual_graph_proposal._raw_sources",
                       return_value=iter(RAW.items())), patch(
                       "ebook_private_visual_graph_proposal.render_page",
                       side_effect=fake_render):
                result = run(MANIFEST, folder, "sufficiently_long_key",
                             fitz=None, requests_module=fake, allow_cloud=True)
            self.assertEqual(len(result), 2)
            self.assertEqual(len(fake.calls), 2)
            for book in ("B15", "B31"):
                report = folder / "semantic_gate" / (
                    FILE_PREFIX + book + ".candidate.private.json")
                self.assertTrue(report.exists())
                self.assertTrue((folder / "semantic_gate" /
                                 (FILE_PREFIX + book + ".request.private.json")).exists())
                self.assertEqual(json.loads(report.read_text())["page"]["book_id"], book)
            self.assertTrue(all(c[1]["allow_redirects"] is False for c in fake.calls))
            self.assertTrue(all(c[1]["timeout"] == (15, 100) for c in fake.calls))

    def test_preflight_rejects_unknown_paid_attempt_without_retry(self):
        with tempfile.TemporaryDirectory() as t:
            folder = Path(t)
            bad = FakeRequests(error=True)
            with patch("ebook_private_visual_graph_proposal._raw_sources",
                       return_value=iter(RAW.items())), patch(
                       "ebook_private_visual_graph_proposal.render_page",
                       side_effect=fake_render):
                with self.assertRaisesRegex(VisualGateError,
                                            "VISION_TRANSPORT_UNKNOWN_OUTCOME"):
                    run(MANIFEST, folder, "sufficiently_long_key",
                        fitz=None, requests_module=bad, allow_cloud=True)
                self.assertEqual(len(bad.calls), 1)
                with self.assertRaisesRegex(VisualGateError,
                                            "PAID_REQUEST_ALREADY_STARTED_NO_AUTO_RETRY"):
                    run(MANIFEST, folder, "sufficiently_long_key",
                        fitz=None, requests_module=bad, allow_cloud=True)
                self.assertEqual(len(bad.calls), 1)

    def test_missing_cloud_permission_causes_zero_requests(self):
        with tempfile.TemporaryDirectory() as t:
            folder = Path(t)
            fake = FakeRequests([B15, B31])
            with patch("ebook_private_visual_graph_proposal._raw_sources",
                       return_value=iter(RAW.items())):
                with self.assertRaisesRegex(VisualGateError,
                                            "CLOUD_VISION_NOT_EXPLICITLY_ENABLED"):
                    run(MANIFEST, folder, "sufficiently_long_key",
                        fitz=None, requests_module=fake, allow_cloud=False)
            self.assertEqual(fake.calls, [])

    def test_missing_private_book_does_not_call_provider(self):
        with tempfile.TemporaryDirectory() as t:
            with patch("ebook_private_visual_graph_proposal._raw_sources",
                       return_value=iter([("B15", RAW["B15"])])):
                with self.assertRaisesRegex(VisualGateError, "PRIVATE_SOURCE_MISSING"):
                    prepare(Path(t), MANIFEST)

    def test_model_cannot_submit_claims_or_change_page(self):
        altered = dict(B15)
        altered["graphVerified"] = True
        with self.assertRaisesRegex(VisualGateError, "STRUCTURE_MODEL_SCHEMA_INVALID"):
            parse_candidate(json.dumps(altered), "B15", SELECTED["B15"])
        altered = dict(B15)
        altered["objects"] = B15["objects"] + [{"role": "x", "kind": "chart",
                                                "humanVerified": True}]
        with self.assertRaisesRegex(VisualGateError, "UNAUTHORIZED_VERIFICATION_CLAIM"):
            parse_candidate(json.dumps(altered), "B15", SELECTED["B15"])

    def test_no_chart_series_or_no_directed_edge_is_not_success(self):
        no_series = dict(B15)
        no_series["objects"] = [B15["objects"][0]]
        no_series["trends"] = []
        with self.assertRaisesRegex(VisualGateError, "CHART_SERIES_EVIDENCE_INCOMPLETE"):
            parse_candidate(json.dumps(no_series), "B15", SELECTED["B15"])
        no_edges = dict(B31)
        no_edges["relations"] = []
        with self.assertRaisesRegex(VisualGateError, "DIRECTED_GRAPH_EVIDENCE_INCOMPLETE"):
            parse_candidate(json.dumps(no_edges), "B31", SELECTED["B31"])

    def test_abstention_is_valid_but_not_recognition(self):
        a = parse_candidate(json.dumps(ABSTAINED), "B15", SELECTED["B15"])
        self.assertTrue(a["abstained"])
        self.assertFalse(a["objects"])

    def test_invalid_json_and_untrusted_extra_model_keys(self):
        with self.assertRaisesRegex(VisualGateError, "STRUCTURE_MODEL_JSON_INVALID"):
            parse_candidate("```json {}", "B31", SELECTED["B31"])
        self.assertIn("untrusted", build_prompt("B15", "chart").lower())
        self.assertNotIn(SELECTED["B15"]["sha256"], build_prompt("B15", "chart"))

    def test_provider_response_or_secret_not_exposed(self):
        fake = FakeRequests(error=True)
        with self.assertRaisesRegex(VisualGateError, "^VISION_TRANSPORT_UNKNOWN_OUTCOME$"):
            request_structure(b"abc", "prompt", "sufficiently_long_key", fake)
        self.assertEqual(len(fake.calls), 1)
        self.assertNotIn("secret", str(fake.calls[0][1]["timeout"]))


if __name__ == "__main__":
    unittest.main()
