"""No-cost, no-OCR Standard+RapidOCR fallback readiness synthetic gates."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b15_docling_rapidocr_fallback as subject
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    (folder/subject.STANDARD_REPORT).write_text("prior private receipt",encoding="utf-8")
    standard={"book_id":"B15","physical_page":109,
              "docling_installed_version":"2.141.0",
              "docling_standard_ocr_pages_executed":0,
              "docling_native_is_not_standard":True,
              "cer":None,"provider_calls":0,"corpus_id":"TEST",
              "same_single_page_pdf_sha256_private":"a"*64,
              "private_candidate_artifact_inventory":[{
                  "model_weight_files":2,"config_files":3}]}
    rapid={"versions":{"rapidocr":"3.9.2","onnxruntime":"1.22.1"},
           "package_on_private_volume":True,"bundled_det":True,
           "bundled_rec":True,"bundled_model_count":3}
    return folder,standard,rapid


class RapidFallbackTests(unittest.TestCase):
    def bind(self,folder,standard):
        stack=ExitStack()
        stack.enter_context(patch.object(subject,"audit_standard",return_value=standard))
        stack.enter_context(patch.object(subject,"_private_folder",return_value=folder))
        return stack

    def test_tesseract_is_not_required_but_real_standard_remains_unverified(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,standard,rapid=fixture(root)
            with self.bind(folder,standard):
                report=subject.execute(root,{},write=True,probe_fn=lambda r:rapid)
                self.assertEqual(report["status"],
                    "CANDIDATE_ONLY_STANDARD_PIPELINE_RUNTIME_UNVERIFIED")
                self.assertFalse(report["standard_pipeline_initialized"])
                self.assertEqual(report["standard_ocr_pages_executed"],0)
                self.assertIsNone(report["cer"])
                txt=(folder/subject.REPORT).read_text("utf-8")
                self.assertNotIn("prior private receipt",txt)
                self.assertEqual(subject.execute(root,{},audit=True,
                                                 probe_fn=lambda r:rapid),report)
                with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                    subject.execute(root,{},write=True,probe_fn=lambda r:rapid)

    def test_engine_package_and_layout_missing_are_disjoint(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,standard,rapid=fixture(root)
            with self.bind(folder,standard):
                rapid["versions"]["rapidocr"]=None
                self.assertEqual(subject.execute(root,{},probe_fn=lambda r:rapid)["status"],
                    "BLOCKED_DOCLING_ENV_RAPIDOCR_PACKAGE_VERSION")
                rapid["versions"]["rapidocr"]="3.9.2"
                rapid["bundled_det"]=False
                self.assertEqual(subject.execute(root,{},probe_fn=lambda r:rapid)["status"],
                    "BLOCKED_DOCLING_ENV_BUNDLED_RAPIDOCR_MODELS")
                rapid["bundled_det"]=True
                standard["private_candidate_artifact_inventory"][0]["model_weight_files"]=0
                self.assertEqual(subject.execute(root,{},probe_fn=lambda r:rapid)["status"],
                    "BLOCKED_DOCLING_STANDARD_LAYOUT_ARTIFACTS")

    def test_cannot_relabel_docling_native_as_standard(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,standard,rapid=fixture(root)
            with self.bind(folder,standard):
                standard["docling_native_is_not_standard"]=False
                with self.assertRaisesRegex(VisualGateError,"PRIOR_SOURCE_INVALID"):
                    subject.execute(root,{},probe_fn=lambda r:rapid)
                self.assertFalse((folder/subject.REPORT).exists())

    def test_invalid_version_and_frozen_report_tamper(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,standard,rapid=fixture(root)
            with self.bind(folder,standard):
                rapid["bundled_model_count"]=True
                with self.assertRaisesRegex(VisualGateError,"PROBE_SHAPE_INVALID"):
                    subject.execute(root,{},probe_fn=lambda r:rapid)
                rapid["bundled_model_count"]=3
                subject.execute(root,{},write=True,probe_fn=lambda r:rapid)
                (folder/subject.REPORT).write_text("{}",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"FROZEN_RECEIPT_CHANGED"):
                    subject.execute(root,{},audit=True,probe_fn=lambda r:rapid)


if __name__=="__main__":
    unittest.main()
