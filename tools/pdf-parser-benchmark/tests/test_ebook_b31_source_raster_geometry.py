"""Synthetic B31 raster-only geometry and privacy/identity safeguards."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ebook_b31_source_raster_geometry as target

PNG = b"\x89PNG\r\n\x1a\n" + b"synthetic page pixels only, not a real PNG"
SHA = hashlib.sha256(PNG).hexdigest()
PDF_SHA = "b" * 64
MANIFEST = {"sources": [
    {"id": "B15", "size": 15, "sha256": "a" * 64, "total_physical_pages": 300},
    {"id": "B31", "size": 30, "sha256": PDF_SHA, "total_physical_pages": 504},
]}


def fake_rgb(width=96, height=96, *, ink=True):
    buf = bytearray(b"\xff" * (width * height * 3))
    if ink:
        for x in range(8, width - 8):
            for y in (24, 25):
                i = (y * width + x) * 3
                buf[i:i+3] = b"\x00\x00\x00"
        for y in range(6, height - 6):
            for x in (32, 33):
                i = (y * width + x) * 3
                buf[i:i+3] = b"\x00\x00\x00"
        # Dense blob that will meet tile occupancy threshold.
        for y in range(55, 82):
            for x in range(58, 83):
                i = (y * width + x) * 3
                buf[i:i+3] = b"\x00\x00\x00"
    return bytes(buf)


class FakePixmap:
    def __init__(self, content):
        assert content == PNG
        self.width = 96
        self.height = 96
        self.n = 3
        self.alpha = 0
        self.stride = self.width * 3
        self.samples = fake_rgb()


class FakeFitz:
    Pixmap = FakePixmap


def setup(root):
    folder = root / "semantic_gate"
    folder.mkdir()
    (folder/"b31_source_only_page126.private.png").write_bytes(PNG)
    meta = {
        "schema_version": 1,
        "provenance": "PDF_NATIVE_INDEPENDENT_OF_GLM_PREDICTION",
        "book_id": "B31",
        "physical_page": 126,
        "source_document_sha256": PDF_SHA,
        "private_png_sha256": SHA,
        "render_width": 96,
        "render_height": 96,
        "human_verified": False,
        "certified_graph_f1": None,
    }
    path = folder/"b31_source_only_page126.private.json"
    path.write_text(json.dumps(meta), encoding="utf-8")
    return folder, path


class B31RasterGeometry(unittest.TestCase):
    def test_source_image_ink_runs_are_not_graph_edges(self):
        output = target.source_features(96, 96, fake_rgb())
        self.assertGreater(output["foreground_pixels"], 0)
        self.assertGreater(output["rows_with_long_ink_run"], 0)
        self.assertGreater(output["columns_with_long_ink_run"], 0)
        self.assertGreater(output["occupied_tiles"], 0)
        self.assertGreater(output["raster_tile_component_count"], 0)
        self.assertFalse(output["node_count_verified"])
        self.assertFalse(output["arrow_direction_verified"])
        self.assertIsNone(output["independent_graph_gold"])
        self.assertIsNone(output["certified_graph_f1"])

    def test_blank_source_stays_blank_and_not_gold(self):
        output = target.source_features(96, 96, fake_rgb(ink=False))
        self.assertEqual(output["foreground_pixels"], 0)
        self.assertIsNone(output["foreground_bbox"])
        self.assertEqual(output["occupied_tiles"], 0)
        self.assertEqual(output["raster_tile_component_count"], 0)
        self.assertEqual(output["rows_with_long_ink_run"], 0)

    def test_malformed_rgb_fails_closed(self):
        for args in ((96, 96, b"test"), (0, 96, b""),
                     (96, 96, fake_rgb(), 4),
                     (96, 96, fake_rgb(), 3, 10)):
            with self.subTest(args=str(args[:2])):
                with self.assertRaises(target.VisualGateError):
                    target.source_features(*args)

    def test_readonly_source_does_not_look_at_existing_model_candidate(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            folder, _=setup(root)
            confidential = folder/"visual_graph_proposal_B31.candidate.private.json"
            confidential.write_text("PRIVATE_PREDICTION_MUST_NOT_BE_READ", encoding="utf-8")
            result=target.run(root, MANIFEST, FakeFitz, write=False)
            self.assertEqual(result["book_id"], "B31")
            self.assertGreater(result["foreground_pixels"], 0)
            self.assertEqual(confidential.read_text(), "PRIVATE_PREDICTION_MUST_NOT_BE_READ")
            self.assertFalse((folder/target.REPORT_NAME).exists())

    def test_write_report_exclusive_and_raster_receipt_immutable(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            folder, _=setup(root)
            image=(folder/"b31_source_only_page126.private.png")
            original_image=image.read_bytes()
            result=target.run(root, MANIFEST, FakeFitz, write=True)
            report=folder/target.REPORT_NAME
            saved=json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(saved["foreground_pixels"], result["foreground_pixels"])
            self.assertEqual(saved["source_page_png_sha256"], SHA)
            self.assertEqual(saved["evidence"], "SOURCE_RASTER_GEOMETRY_UNSUPERVISED_NOT_GOLD")
            self.assertEqual(image.read_bytes(), original_image)
            with self.assertRaisesRegex(target.VisualGateError, "ALREADY_EXISTS"):
                target.run(root, MANIFEST, FakeFitz, write=True)

    def test_tampered_png_hash_rejected_before_decode(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            folder, _=setup(root)
            (folder/"b31_source_only_page126.private.png").write_bytes(PNG + b"x")
            with self.assertRaisesRegex(target.VisualGateError, "PROVENANCE_INVALID"):
                target.run(root, MANIFEST, FakeFitz)

    def test_wrong_source_sha_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            setup(root)
            modified=json.loads(json.dumps(MANIFEST))
            modified["sources"][1]["sha256"]="c"*64
            with self.assertRaisesRegex(target.VisualGateError, "PROVENANCE_INVALID"):
                target.run(root, modified, FakeFitz)

    def test_untrusted_provenance_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            _, meta_path=setup(root)
            meta=json.loads(meta_path.read_text(encoding="utf-8"))
            meta["human_verified"]=True
            meta_path.write_text(json.dumps(meta), encoding="utf-8")
            with self.assertRaisesRegex(target.VisualGateError, "PROVENANCE_INVALID"):
                target.run(root, MANIFEST, FakeFitz)

    def test_absent_output_directory_not_created(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with self.assertRaisesRegex(target.VisualGateError, "OUTPUT_DIRECTORY"):
                target.run(root, MANIFEST, FakeFitz, write=True)
            self.assertFalse((root/"semantic_gate").exists())

    def test_mismatched_decoded_dimensions_rejected(self):
        class BadPixmap(FakePixmap):
            def __init__(self, content):
                super().__init__(content)
                self.width=95
        class BadFitz:
            Pixmap=BadPixmap
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            setup(root)
            with self.assertRaisesRegex(target.VisualGateError, "DECODE_MISMATCH"):
                target.run(root, MANIFEST, BadFitz)


if __name__ == "__main__":
    unittest.main()
