"""Synthetic OpenCV source geometry, SHA, no gold and no-LLM isolation gates."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ebook_b31_opencv_candidates as subject

# Dependency exists on the actual Windows runner; CI pins a binary wheel.
import cv2
import numpy as np

SOURCE_SHA = "b" * 64
MANIFEST = {"sources": [
    {"id": "B15", "size": 8, "sha256": "a"*64, "total_physical_pages": 438},
    {"id": "B31", "size": 54, "sha256": SOURCE_SHA, "total_physical_pages": 504},
]}


def fake_png():
    image = np.full((300, 480, 3), 255, np.uint8)
    cv2.rectangle(image, (40,50), (140,112), (0,0,0), 2)
    cv2.rectangle(image, (305,50), (418,112), (0,0,0), 2)
    cv2.line(image, (142,81), (250,81), (0,0,0), 2)
    triangle = np.array([[271,81],[258,72],[258,90]], np.int32)
    cv2.fillConvexPoly(image, triangle, (0,0,0))
    valid, payload = cv2.imencode(".png", image)
    assert valid
    return payload.tobytes()


def fixture(root, *, meta_changes=None):
    folder = root / "semantic_gate"
    folder.mkdir()
    png = fake_png()
    path = folder/"b31_source_only_page126.private.png"
    path.write_bytes(png)
    metadata = {
        "schema_version": 1,
        "provenance": "PDF_NATIVE_INDEPENDENT_OF_GLM_PREDICTION",
        "book_id": "B31", "physical_page": 126,
        "render_width": 480, "render_height": 300,
        "source_document_sha256": SOURCE_SHA,
        "private_png_sha256": hashlib.sha256(png).hexdigest(),
        "human_verified": False, "certified_graph_f1": None,
    }
    metadata.update(meta_changes or {})
    (folder/"b31_source_only_page126.private.json").write_text(
        json.dumps(metadata), encoding="utf-8")
    return folder, path


class SourceOnlyCvTests(unittest.TestCase):
    def test_synthetic_rectangles_shafts_triangles_never_gold(self):
        result = subject.source_candidates(fake_png(), {
            "render_width": 480, "render_height": 300,
        }, cv2, np)
        self.assertGreater(result["hough_line_candidate_count_total"], 0)
        self.assertGreater(result["quadrilateral_candidate_count_total"], 0)
        self.assertGreater(result["triangle_candidate_count_total"], 0)
        self.assertFalse(result["node_count_verified"])
        self.assertFalse(result["arrow_direction_verified"])
        self.assertIsNone(result["independent_graph_gold"])
        self.assertIsNone(result["certified_graph_f1"])

    def test_blank_page_yields_no_graph_hypotheses(self):
        blank = np.full((150,150,3), 255, np.uint8)
        valid, image = cv2.imencode(".png", blank)
        self.assertTrue(valid)
        output = subject.source_candidates(image.tobytes(), {
            "render_width": 150, "render_height": 150,
        }, cv2, np)
        self.assertEqual(output["hough_line_candidate_count_total"], 0)
        self.assertEqual(output["triangle_candidate_count_total"], 0)
        self.assertFalse(output["arrow_direction_verified"])

    def test_invalid_png_or_dimensions_fail_before_inference(self):
        png = fake_png()
        for image, meta in (
            (b"invalid PNG", {"render_width":480,"render_height":300}),
            (png, {"render_width":475,"render_height":300}),
            (png, {"render_width":480,"render_height":300.0}),
        ):
            with self.subTest(size=len(image)):
                with self.assertRaises(subject.VisualGateError):
                    subject.source_candidates(image, meta, cv2, np)

    def test_oversized_png_ihdr_rejected_before_decode(self):
        png = bytearray(fake_png())
        png[16:20] = (30000).to_bytes(4, "big")
        png[20:24] = (30000).to_bytes(4, "big")
        with self.assertRaisesRegex(subject.VisualGateError, "IHDR"):
            subject.source_candidates(bytes(png),
                                      {"render_width":30000,"render_height":30000},
                                      cv2, np)

    def test_read_only_does_not_read_or_modify_poisoned_candidate(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            folder, image = fixture(root)
            secret = folder/"visual_graph_proposal_B31.candidate.private.json"
            secret.write_bytes(b"CONFIDENTIAL_PREDICTION_NOT_FOR_CV")
            before = image.read_bytes(), secret.read_bytes()
            result = subject.run(root, MANIFEST, cv2, np)
            self.assertGreater(result["hough_line_candidate_count_total"], 0)
            self.assertEqual((image.read_bytes(), secret.read_bytes()), before)
            self.assertFalse((folder/subject.REPORT).exists())

    def test_write_exclusive_no_source_mutations(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            folder, png = fixture(root)
            original = png.read_bytes()
            actual = subject.run(root, MANIFEST, cv2, np, write=True)
            report = folder/subject.REPORT
            saved = json.loads(report.read_text())
            self.assertEqual(actual, saved)
            self.assertEqual(saved["source_page_png_sha256"],
                             hashlib.sha256(original).hexdigest())
            self.assertEqual(png.read_bytes(), original)
            self.assertFalse(saved["node_count_verified"])
            self.assertTrue(saved["candidate_count_is_not_graph_count"])
            with self.assertRaisesRegex(subject.VisualGateError, "ALREADY_EXISTS"):
                subject.run(root, MANIFEST, cv2, np, write=True)

    def test_corrupted_source_png_sha_rejected(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            _, image = fixture(root)
            image.write_bytes(image.read_bytes() + b"tamper")
            with self.assertRaisesRegex(subject.VisualGateError, "PROVENANCE_INVALID"):
                subject.run(root, MANIFEST, cv2, np)

    def test_wrong_document_sha_rejected(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            fixture(root)
            wrong = json.loads(json.dumps(MANIFEST))
            wrong["sources"][1]["sha256"] = "c"*64
            with self.assertRaisesRegex(subject.VisualGateError, "PROVENANCE_INVALID"):
                subject.run(root, wrong, cv2, np)

    def test_false_human_gold_rejected(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            fixture(root, meta_changes={"human_verified": True})
            with self.assertRaisesRegex(subject.VisualGateError, "PROVENANCE_INVALID"):
                subject.run(root, MANIFEST, cv2, np)

    def test_missing_evidence_never_creates_folder(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            with self.assertRaises(subject.VisualGateError):
                subject.run(root, MANIFEST, cv2, np, write=True)
            self.assertFalse((root/"semantic_gate").exists())


if __name__ == "__main__":
    unittest.main()
