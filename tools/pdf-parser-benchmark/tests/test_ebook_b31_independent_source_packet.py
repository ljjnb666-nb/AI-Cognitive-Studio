"""All-synthetic source-only B31 evidence tests; no user PDFs or GLM models."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ebook_b31_independent_source_packet as target

PDF = b"synthetic private B31 PDF-like bytes"
SHA = hashlib.sha256(PDF).hexdigest()
MANIFEST = {"sources": [
    {"id": "B15", "size": 8, "sha256": "a"*64, "total_physical_pages": 438},
    {"id": "B31", "size": len(PDF), "sha256": SHA, "total_physical_pages": 504},
]}


class FakePixel:
    width, height = 800, 900

    def tobytes(self, kind):
        assert kind == "png"
        return b"synthetic PNG pixels only"


class FakePage:
    rotation = 0

    def get_pixmap(self, **kwargs):
        return FakePixel()

    def get_drawings(self):
        return [{"type": "s"}]*7

    def get_images(self, full):
        return [(1,)]*2

    def get_text(self, kind):
        assert kind == "blocks"
        return [(0,0,1,1,"not printed",0,0)]*3 + [(0,0,1,1,"image",0,1)]


class FakeDocument:
    page_count = 504

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def __getitem__(self, index):
        if index != 125:
            raise AssertionError("must index physical page 126 as 125")
        return FakePage()


class FakeMatrix:
    def __init__(self,*dims):
        self.dims=dims


class FakeFitz:
    Matrix = FakeMatrix
    csRGB = object()

    @staticmethod
    def open(**kwargs):
        assert kwargs["stream"] == PDF
        assert kwargs["filetype"] == "pdf"
        return FakeDocument()


class SourceOnlyPacketTests(unittest.TestCase):
    def make_root(self, tmp):
        root = Path(tmp)
        (root/"semantic_gate").mkdir()
        return root

    def test_readonly_native_evidence_is_not_model_gold(self):
        with tempfile.TemporaryDirectory() as temp:
            root=self.make_root(temp)
            with patch.object(target, "_raw_sources", return_value=iter([("B31", PDF)])):
                report=target.run(root, MANIFEST, FakeFitz, write_packet=False)
            self.assertEqual(report["native_drawing_paths"], 7)
            self.assertEqual(report["native_image_entries"], 2)
            self.assertEqual(report["native_text_blocks"], 3)
            self.assertIsNone(report["certified_graph_f1"])
            self.assertFalse(report["human_verified"])
            self.assertFalse(list((root/"semantic_gate").iterdir()))

    def test_private_png_and_receipt_exclusive(self):
        with tempfile.TemporaryDirectory() as temp:
            root=self.make_root(temp)
            with patch.object(target, "_raw_sources", return_value=iter([("B31", PDF)])):
                report=target.run(root, MANIFEST, FakeFitz, write_packet=True)
            self.assertTrue(report["written"])
            folder=root/"semantic_gate"
            png=folder/"b31_source_only_page126.private.png"
            meta=folder/"b31_source_only_page126.private.json"
            self.assertEqual(png.read_bytes(), b"synthetic PNG pixels only")
            data=json.loads(meta.read_text())
            self.assertEqual(data["source_document_sha256"], SHA)
            self.assertEqual(data["physical_page"], 126)
            self.assertNotIn("GLM", meta.read_text())
            original=png.read_bytes()
            with patch.object(target, "_raw_sources", return_value=iter([("B31", PDF)])):
                with self.assertRaisesRegex(target.VisualGateError, "ALREADY_EXISTS"):
                    target.run(root, MANIFEST, FakeFitz, write_packet=True)
            self.assertEqual(png.read_bytes(), original)

    def test_existing_model_candidate_has_no_influence(self):
        with tempfile.TemporaryDirectory() as temp:
            root=self.make_root(temp)
            (root/"semantic_gate"/"visual_graph_proposal_B31.candidate.private.json").write_text(
                "adversarial bogus graph and fake gold", encoding="utf-8")
            with patch.object(target, "_raw_sources", return_value=iter([("B31", PDF)])):
                report=target.run(root, MANIFEST, FakeFitz)
            self.assertEqual(report["native_drawing_paths"], 7)
            self.assertFalse((root/"semantic_gate"/
                "b31_source_only_page126.private.png").exists())

    def test_missing_pdf_refused_without_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            root=self.make_root(temp)
            with patch.object(target, "_raw_sources", return_value=iter([])):
                with self.assertRaisesRegex(target.VisualGateError, "PDF_NOT_FOUND"):
                    target.run(root, MANIFEST, FakeFitz, write_packet=True)
            self.assertFalse(list((root/"semantic_gate").iterdir()))

    def test_bad_sha_does_not_render_or_commit(self):
        with tempfile.TemporaryDirectory() as temp:
            root=self.make_root(temp)
            with patch.object(target, "_raw_sources", return_value=iter([
                ("B31", b"bad PDF")
            ])):
                with self.assertRaisesRegex(target.VisualGateError, "SOURCE_MISMATCH"):
                    target.run(root, MANIFEST, FakeFitz, write_packet=True)
            self.assertFalse(list((root/"semantic_gate").iterdir()))

    def test_missing_output_dir_does_not_create(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with self.assertRaisesRegex(target.VisualGateError, "OUTPUT_DIRECTORY"):
                target.run(root, MANIFEST, FakeFitz, write_packet=True)
            self.assertFalse((root/"semantic_gate").exists())

    def test_zip_pdf_source_only_selector(self):
        with tempfile.TemporaryDirectory() as temp:
            root=self.make_root(temp)
            selected=[]
            def fake_scan(r, lookup):
                selected.extend(lookup.values())
                yield "B31", PDF
            with patch.object(target,"_raw_sources",side_effect=fake_scan):
                target.run(root, MANIFEST, FakeFitz)
            self.assertEqual(selected, ["B31"])

    def test_source_without_glm_facts_does_not_claim_accuracy(self):
        png, result=target.independent_observation(PDF, MANIFEST["sources"][1], FakeFitz)
        self.assertEqual(result["interpretation"], "SOURCE_ONLY_NOT_GRAPH_GOLD")
        self.assertNotIn("nodes", result)
        self.assertNotIn("arrows", result)
        self.assertNotIn("edges", result)
        self.assertTrue(png)


if __name__ == "__main__":
    unittest.main()
