"""Synthetic only: bijective node-ID mapping must preserve topology and privacy."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from ebook_private_b31_offline_role_mapping import (
    VisualGateError, normalize, offline_candidate, main,
)
from ebook_private_graph_reply_recovery import capture_reply
from ebook_private_graph_receipt_audit import MARKER_STATUS
from ebook_semantic_structure_gate import ROLE

SHA = hashlib.sha256(b"private synthetic B31").hexdigest()
MANIFEST = {"sources": [
    {"id": "B15", "size": 20, "sha256": "a" * 64,
     "total_physical_pages": 438},
    {"id": "B31", "size": 21, "sha256": SHA,
     "total_physical_pages": 504},
]}
TOPOLOGY = {
    "objects": [
        {"role": "起点", "kind": "node"},
        {"role": "解析", "kind": "node"},
        {"role": "存储", "kind": "node"},
        {"role": "结果", "kind": "node"},
        {"role": "反馈", "kind": "node"},
    ],
    "relations": [
        {"source_role": "起点", "target_role": "解析",
         "relation": "flows_to", "directed": True},
        {"source_role": "解析", "target_role": "存储",
         "relation": "flows_to", "directed": True},
        {"source_role": "存储", "target_role": "结果",
         "relation": "flows_to", "directed": True},
        {"source_role": "结果", "target_role": "反馈",
         "relation": "flows_to", "directed": True},
    ],
    "axes": [], "trends": [], "abstained": False,
}


def seed(root, reply=None, *, finish="stop"):
    folder = root / "semantic_gate"
    folder.mkdir(exist_ok=True)
    marker = {
        "status": MARKER_STATUS, "source_document_sha256": SHA,
        "physical_page": 126, "model": "glm-4.6v", "provider": "GLM",
    }
    marker_path = folder / "visual_graph_proposal_B31.request.private.json"
    marker_path.write_text(json.dumps(marker), encoding="utf-8")
    response = json.dumps(reply if reply is not None else TOPOLOGY,
                          ensure_ascii=False)
    envelope = capture_reply(root, "B31", SHA, response, finish_reason=finish)
    return marker_path, envelope


class B31OfflineRoleMapping(unittest.TestCase):
    def test_five_unicode_nodes_and_four_edges_preserve_direction(self):
        normalized, mapped = normalize(TOPOLOGY)
        self.assertEqual(mapped, 5)
        roles = [x["role"] for x in normalized["objects"]]
        self.assertEqual(roles, ["anon_node_001", "anon_node_002", "anon_node_003",
                                 "anon_node_004", "anon_node_005"])
        self.assertTrue(all(ROLE.fullmatch(x) for x in roles))
        self.assertEqual([(x["source_role"], x["target_role"]) for x in
                          normalized["relations"]], [
            ("anon_node_001", "anon_node_002"),
            ("anon_node_002", "anon_node_003"),
            ("anon_node_003", "anon_node_004"),
            ("anon_node_004", "anon_node_005"),
        ])
        self.assertEqual([x["directed"] for x in normalized["relations"]],
                         [True] * 4)
        self.assertEqual(TOPOLOGY["objects"][0]["role"], "起点")

    def test_preview_does_not_touch_private_marker_reply_or_candidate(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            marker, reply = seed(root)
            before = marker.read_bytes(), reply.read_bytes()
            report = offline_candidate(root, MANIFEST)
            self.assertEqual(report["renamed_nodes"], 5)
            self.assertEqual(report["objects"], 5)
            self.assertEqual(report["directed_edges"], 4)
            self.assertEqual((marker.read_bytes(), reply.read_bytes()), before)
            self.assertFalse((root/"semantic_gate"/
                              "visual_graph_proposal_B31.candidate.private.json").exists())

    def test_explicit_write_only_once_and_no_raw_chinese_node_labels(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            marker, reply = seed(root)
            raw = reply.read_bytes()
            self.assertEqual(offline_candidate(root, MANIFEST, write=True)["status"],
                             "PRIVATE_CANDIDATE_WRITTEN_PROVISIONAL")
            candidate = root/"semantic_gate"/"visual_graph_proposal_B31.candidate.private.json"
            data = json.loads(candidate.read_text(encoding="utf-8"))
            self.assertEqual(len(data["objects"]), 5)
            self.assertEqual(len(data["relations"]), 4)
            self.assertNotIn("起点", candidate.read_text(encoding="utf-8"))
            self.assertEqual(reply.read_bytes(), raw)
            with self.assertRaisesRegex(VisualGateError, "B31_CANDIDATE_ALREADY_EXISTS"):
                offline_candidate(root, MANIFEST, write=True)

    def test_broken_or_unknown_endpoint_is_rejected(self):
        broken = json.loads(json.dumps(TOPOLOGY, ensure_ascii=False))
        broken["relations"][0]["target_role"] = "不存在的目标"
        with self.assertRaisesRegex(VisualGateError, "B31_UNRESOLVED_NODE_REFERENCE"):
            normalize(broken)

    def test_duplicate_node_labels_ambiguity_rejected(self):
        duplicated = json.loads(json.dumps(TOPOLOGY, ensure_ascii=False))
        duplicated["objects"][1]["role"] = duplicated["objects"][0]["role"]
        with self.assertRaisesRegex(VisualGateError, "B31_DUPLICATE_OR_AMBIGUOUS_NODE_ID"):
            normalize(duplicated)

    def test_generated_token_collision_and_untrusted_ascii_rejected(self):
        clash = json.loads(json.dumps(TOPOLOGY, ensure_ascii=False))
        clash["objects"][1]["role"] = "anon_node_001"
        with self.assertRaisesRegex(VisualGateError, "B31_GENERATED_NODE_ID_COLLISION"):
            normalize(clash)
        clash["objects"][1]["role"] = "Node 1"
        with self.assertRaisesRegex(VisualGateError, "B31_UNSUPPORTED_ASCII_NODE_ID"):
            normalize(clash)

    def test_partial_response_not_converted_to_candidate(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            _, saved = seed(root, finish="length")
            with self.assertRaisesRegex(VisualGateError, "REPLY_COMPLETION_NOT_FINAL"):
                offline_candidate(root, MANIFEST, write=True)
            self.assertTrue(saved.exists())
            self.assertFalse((root/"semantic_gate"/
                              "visual_graph_proposal_B31.candidate.private.json").exists())

    def test_incorrect_manifest_identity_and_absent_reply_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            marker, reply = seed(root)
            changed = json.loads(json.dumps(MANIFEST))
            changed["sources"][1]["sha256"] = "b" * 64
            with self.assertRaisesRegex(VisualGateError, "REQUEST_MARKER_IDENTITY_INVALID"):
                offline_candidate(root, changed)
            reply.unlink()
            with self.assertRaisesRegex(VisualGateError, "B31_ORIGINAL_REPLY_NOT_CAPTURED"):
                offline_candidate(root, MANIFEST)

    def test_cli_never_prints_source_text_sha_or_private_path(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            seed(root)
            manifest = root/"manifest.json"
            manifest.write_text(json.dumps(MANIFEST), encoding="utf-8")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(main(["--private-root", str(root),
                                       "--manifest", str(manifest)]), 0)
            msg = out.getvalue()
            for private in ["起点", "结果", SHA, str(root)]:
                self.assertNotIn(private, msg)
            self.assertIn("ACS_B31_NEW_PROVIDER_CALLS=0", msg)
            self.assertIn("PROVISIONAL_GRAPH_NOT_INDEPENDENT_GOLD", msg)


if __name__ == "__main__":
    unittest.main()
