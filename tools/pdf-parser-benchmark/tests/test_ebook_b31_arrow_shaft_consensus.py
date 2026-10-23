"""Pure synthetic B31 shaft-tip geometry and private provenance, no AI."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ebook_b31_arrow_shaft_consensus as subject

PNG = b"\x89PNG\r\n\x1a\nsynthetic image identity ONLY"
PNG_SHA = hashlib.sha256(PNG).hexdigest()
PDF_SHA = "b" * 64
MANIFEST = {"sources": [
    {"id": "B15", "size": 10, "sha256": "a"*64, "total_physical_pages": 438},
    {"id": "B31", "size": 30, "sha256": PDF_SHA, "total_physical_pages": 504},
]}
WIDTH, HEIGHT = 256, 160
SHAFT = [[20, 60, 82, 60], [86, 60, 128, 60]]
HEAD = [[140, 48], [140, 72], [158, 60]]


def seed(root, *, lines=None, triangles=None, mutate=None):
    folder = root/"semantic_gate"
    folder.mkdir()
    (folder/"b31_source_only_page126.private.png").write_bytes(PNG)
    metadata = {
        "schema_version": 1,
        "book_id": "B31",
        "physical_page": 126,
        "source_document_sha256": PDF_SHA,
        "private_png_sha256": PNG_SHA,
        "render_width": WIDTH,
        "render_height": HEIGHT,
        "provenance": "PDF_NATIVE_INDEPENDENT_OF_GLM_PREDICTION",
        "human_verified": False,
        "certified_graph_f1": None,
    }
    (folder/"b31_source_only_page126.private.json").write_text(
        json.dumps(metadata), encoding="utf-8")
    data = {
        "schema_version": 1,
        "evidence": "SOURCE_OPENCV_UNSUPERVISED_NOT_GRAPH_GOLD",
        "book_id": "B31", "physical_page": 126,
        "source_document_sha256": PDF_SHA,
        "source_page_png_sha256": PNG_SHA,
        "candidate_count_is_not_graph_count": True,
        "node_count_verified": False,
        "arrow_direction_verified": False,
        "independent_graph_gold": None,
        "certified_graph_f1": None,
        "hough_line_candidates": SHAFT if lines is None else lines,
        "triangle_vertices": [HEAD] if triangles is None else triangles,
        "line_candidates_truncated": False,
        "triangles_truncated": False,
    }
    data.update(mutate or {})
    (folder/"b31_opencv_source_candidates.private.json").write_text(
        json.dumps(data), encoding="utf-8")
    return folder


class ShaftConsensusTests(unittest.TestCase):
    def test_collinear_fragments_join_with_bounded_gap(self):
        merged = subject.merge_fragments(SHAFT, WIDTH, HEIGHT)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["fragment_count"], 2)
        self.assertEqual(merged[0]["endpoints"], [[20., 60.], [128., 60.]])

    def test_base_tip_alignment_creates_geometric_hypothesis_only(self):
        report = subject.match_geometries(SHAFT, [HEAD], WIDTH, HEIGHT)
        self.assertEqual(report["triangle_shape_hypotheses"], 1)
        self.assertEqual(report["merged_shaft_hypotheses"], 1)
        self.assertEqual(len(report["tip_aligned_pair_hypotheses"]), 1)
        self.assertFalse(report["arrow_direction_verified"])
        self.assertIsNone(report["independent_graph_gold"])
        self.assertIsNone(report["certified_graph_f1"])
        self.assertTrue(report["candidate_count_is_not_graph_count"])

    def test_backward_arrowhead_rejected_by_alignment(self):
        backwards = [[140, 48], [140, 72], [122, 60]]
        report = subject.match_geometries(SHAFT, [backwards], WIDTH, HEIGHT)
        self.assertEqual(len(report["tip_aligned_pair_hypotheses"]), 0)
        self.assertGreater(report["near_head_rejected_by_alignment"], 0)

    def test_distant_unrelated_triangle_has_no_false_edge(self):
        distant = [[208, 119], [208, 141], [224, 130]]
        report = subject.match_geometries(SHAFT, [distant], WIDTH, HEIGHT)
        self.assertEqual(len(report["tip_aligned_pair_hypotheses"]), 0)
        self.assertEqual(report["shaft_near_head_proximity_checks"], 0)

    def test_invalid_triangle_and_segment_coordinates_fail_closed(self):
        with self.assertRaisesRegex(subject.VisualGateError, "COORDINATES_INVALID"):
            subject.match_geometries([[2, 2, 300, 4]], [HEAD], WIDTH, HEIGHT)
        with self.assertRaisesRegex(subject.VisualGateError, "COORDINATES_INVALID"):
            subject.match_geometries(SHAFT, [[[2,2], [4,5], [-1,10]]],
                                     WIDTH, HEIGHT)
        with self.assertRaisesRegex(subject.VisualGateError, "SEGMENT_INPUT_INVALID"):
            subject.merge_fragments([[10, 10, 20, 20]] * 257, WIDTH, HEIGHT)

    def test_source_only_readonly_not_contaminated_by_saved_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder=seed(root)
            model=folder/"visual_graph_proposal_B31.candidate.private.json"
            model.write_text("PRIVATE_MODEL_CONTENT_MUST_REMAIN_UNREAD", encoding="utf-8")
            response=subject.run(root, MANIFEST)
            self.assertEqual(len(response["tip_aligned_pair_hypotheses"]), 1)
            self.assertEqual(model.read_text(), "PRIVATE_MODEL_CONTENT_MUST_REMAIN_UNREAD")
            self.assertFalse((folder/subject.OUTPUT).exists())

    def test_explicit_private_write_is_exclusive_and_preserves_original(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder=seed(root)
            source=folder/"b31_opencv_source_candidates.private.json"
            original=source.read_bytes()
            response=subject.run(root, MANIFEST, write=True)
            out=folder/subject.OUTPUT
            disk=json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(disk, response)
            self.assertEqual(source.read_bytes(), original)
            self.assertFalse(disk["arrow_direction_verified"])
            with self.assertRaisesRegex(subject.VisualGateError, "ALREADY_EXISTS"):
                subject.run(root, MANIFEST, write=True)

    def test_forged_source_provenance_and_fake_gold_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            seed(root,mutate={"source_document_sha256": "c"*64})
            with self.assertRaisesRegex(subject.VisualGateError, "PROVENANCE_INVALID"):
                subject.run(root, MANIFEST)
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            seed(root,mutate={"arrow_direction_verified": True})
            with self.assertRaisesRegex(subject.VisualGateError, "PROVENANCE_INVALID"):
                subject.run(root, MANIFEST)

    def test_mismatched_png_digest_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder=seed(root)
            (folder/"b31_source_only_page126.private.png").write_bytes(PNG+b"x")
            with self.assertRaisesRegex(subject.VisualGateError, "PROVENANCE_INVALID"):
                subject.run(root, MANIFEST)

    def test_missing_directory_and_poisoned_schema_fail_without_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            with self.assertRaises(subject.VisualGateError):
                subject.run(root, MANIFEST, write=True)
            self.assertFalse((root/"semantic_gate").exists())
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder=seed(root, mutate={"triangle_vertices": "private arbitrary"})
            with self.assertRaisesRegex(subject.VisualGateError, "COLLECTION_INVALID"):
                subject.run(root, MANIFEST, write=True)
            self.assertFalse((folder/subject.OUTPUT).exists())


if __name__ == "__main__":
    unittest.main()
