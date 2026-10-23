"""Synthetic role-shape diagnostics only, no user book data or GLM calls."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ebook_private_graph_role_diagnosis import (
    VisualGateError, diagnose, main, reason, summarize,
)
from ebook_private_graph_reply_recovery import capture_reply
from ebook_private_graph_receipt_audit import MARKER_STATUS

BOOK = "B31"
RAW = b"synthetic B31 bytes"
SHA = hashlib.sha256(RAW).hexdigest()
MANIFEST = {"sources": [
    {"id": "B15", "size": 8, "sha256": "a" * 64,
     "total_physical_pages": 400},
    {"id": BOOK, "size": len(RAW), "sha256": SHA,
     "total_physical_pages": 504},
]}
EMPTY = {"objects": [], "relations": [], "axes": [],
         "trends": [], "abstained": True}


def private_record(root, data, *, finish_reason="stop"):
    folder = root / "semantic_gate"
    folder.mkdir(exist_ok=True)
    marker = {
        "status": MARKER_STATUS,
        "source_document_sha256": SHA,
        "physical_page": 126,
        "model": "glm-4.6v",
        "provider": "GLM",
    }
    (folder/"visual_graph_proposal_B31.request.private.json").write_text(
        json.dumps(marker), encoding="utf-8")
    return capture_reply(root, BOOK, SHA, json.dumps(data),
                         finish_reason=finish_reason)


class RoleDiagnosis(unittest.TestCase):
    def test_classifier_uses_only_fixed_error_categories(self):
        inputs = [
            (None, "non_string"), ("", "empty"), (" " * 2, "surrounding_whitespace"),
            ("Node_1", "uppercase"), ("节点一", "non_ascii"),
            ("9node", "invalid_prefix"), ("node-a", "punctuation_or_spacing"),
            ("a" * 65, "too_long"),
        ]
        for value, expected in inputs:
            with self.subTest(expected=expected):
                self.assertEqual(reason(value), expected)

    def test_shape_counts_never_echo_role_values(self):
        data = {
            "objects": [
                {"role": "节点一", "kind": "node"},
                {"role": "Node_2", "kind": "a-b"},
            ],
            "relations": [
                {"source_role": "Node_2", "target_role": "节点一",
                 "relation": "has space", "directed": True},
            ],
            "axes": [], "trends": [], "abstained": False,
        }
        result = summarize(data)
        self.assertEqual(result["invalid_token_count"], 6)
        self.assertEqual(result["invalid_fields"]["object_role"], 2)
        self.assertEqual(result["invalid_fields"]["object_kind"], 1)
        self.assertEqual(result["invalid_fields"]["edge_relation"], 1)
        self.assertEqual(result["invalid_types"]["non_ascii"], 2)
        self.assertFalse(result["candidate_certified"])

    def test_private_snapshot_sha_bound_and_only_counts_public(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = dict(EMPTY)
            data["objects"] = [{"role": "机密节点", "kind": "node"}]
            snapshot = private_record(root, data)
            existing = snapshot.read_bytes()
            result = diagnose(root, MANIFEST)
            self.assertEqual(result["invalid_fields"], {"object_role": 1})
            self.assertEqual(existing, snapshot.read_bytes())
            manifest_path = root/"manifest.json"
            manifest_path.write_text(json.dumps(MANIFEST), encoding="utf-8")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(main(["--private-root", str(root),
                                       "--manifest", str(manifest_path)]), 0)
            text = out.getvalue()
            self.assertIn("INVALID_FIELD=object_role|COUNT=1", text)
            for forbidden in ("机密节点", SHA, str(root), "node"):
                if forbidden == "node":
                    continue
                self.assertNotIn(forbidden, text)
            self.assertIn("ACS_B31_PROVIDER_CALLS=0", text)
            self.assertFalse((root/"semantic_gate"/
                              "visual_graph_proposal_B31.candidate.private.json").exists())

    def test_valid_roles_and_empty_payload_have_zero_violations(self):
        self.assertEqual(summarize(EMPTY)["invalid_token_count"], 0)
        data = dict(EMPTY)
        data["objects"] = [{"role": "node_1", "kind": "node"}]
        self.assertEqual(summarize(data)["invalid_token_count"], 0)

    def test_missing_snapshot_is_not_guessed_or_new_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/"semantic_gate").mkdir()
            with self.assertRaisesRegex(VisualGateError, "REQUEST_MARKER_REQUIRED"):
                diagnose(root, MANIFEST)

    def test_nonterminal_private_reply_is_not_inspected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            private_record(root, EMPTY, finish_reason="length")
            with self.assertRaisesRegex(VisualGateError, "B31_REPLY_NONTERMINAL"):
                diagnose(root, MANIFEST)

    def test_bad_shape_fails_without_emitting_model_values(self):
        bad = dict(EMPTY)
        bad["relations"] = "secret malformed relation"
        with self.assertRaisesRegex(VisualGateError, "DIAGNOSIS_COLLECTION_INVALID"):
            summarize(bad)

    def test_b31_only_scope_and_candidate_immutability(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            private_record(root, EMPTY)
            with self.assertRaisesRegex(VisualGateError, "B31_ONLY_DIAGNOSIS"):
                diagnose(root, MANIFEST, book="B15")
            candidate = root/"semantic_gate"/"visual_graph_proposal_B31.candidate.private.json"
            candidate.write_text("immutable synthetic", encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError, "B31_CANDIDATE_EXISTS"):
                diagnose(root, MANIFEST)


if __name__ == "__main__":
    unittest.main()
