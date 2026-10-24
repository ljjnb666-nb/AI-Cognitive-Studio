"""Docling Standard readiness checks never execute OCR or reuse Native as Standard."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b15_docling_standard_readiness as target
from ebook_private_glm_visual_reference import VisualGateError


def input_fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    pdf=folder/"docling_native_single_pages"/"B15_p0109.private.pdf"
    pdf.parent.mkdir(parents=True)
    pdf.write_bytes(b"%PDF-1.7\n" + b"synthetic_private_fake"*64)
    docsha="a"*64
    sha=hashlib.sha256(pdf.read_bytes()).hexdigest()
    (folder/"b15_spatial_disagreement_heatmap_3x3.private.json").write_text(
        "private prior spatial synthetic",encoding="utf-8")
    spatial={"book_id":"B15","physical_page":109,"root_cause_verified":False,
             "cer":None,"corpus_id":"SYNTHETIC","original_source_pdf_sha256_private":docsha}
    native={"model_free":True,"docling_native_completed_pages":24,
            "corpus_id":"SYNTHETIC","pages":[{
                "book_id":"B15","physical_page":109,
                "original_pdf_sha256":docsha,"staged_pdf_sha256":sha}]}
    return folder,pdf,spatial,native


def inventory(weight=0,config=0):
    return [{"candidate":candidate,"exists":i==0,
             "model_weight_files":weight if i==0 else 0,
             "config_files":config if i==0 else 0,
             "model_weight_bytes":weight*120000}
            for i,candidate in enumerate(target.ARTIFACT_FOLDERS)]


class ReadinessTests(unittest.TestCase):
    def contexts(self,folder,spatial,native):
        stack=ExitStack()
        stack.enter_context(patch.object(target,"_private_folder",return_value=folder))
        stack.enter_context(patch.object(target,"audit_spatial",return_value=spatial))
        stack.enter_context(patch.object(target,"audit_docling_native",return_value=native))
        return stack

    def test_missing_layout_assets_blocks_even_with_ocr_and_docling(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,pdf,spatial,native=input_fixture(root)
            with self.contexts(folder,spatial,native):
                data=target.execute(root,{},assets_fn=lambda r:inventory(),
                    ocr_fn=lambda:{"binary_available":True,"chi_sim_available":True,
                                    "eng_available":True},
                    package_fn=lambda:"2.141.0",write=True)
                self.assertEqual(data["status"],"BLOCKED_STANDARD_MODEL_ARTIFACTS")
                self.assertEqual(data["docling_standard_ocr_pages_executed"],0)
                self.assertTrue(data["docling_native_is_not_standard"])
                self.assertIsNone(data["cer"])
                frozen=(folder/target.REPORT).read_text("utf-8")
                self.assertNotIn("synthetic_private_fake",frozen)
                self.assertNotIn("private prior spatial synthetic",frozen)
                self.assertEqual(target.execute(root,{},assets_fn=lambda r:inventory(),
                    ocr_fn=lambda:{"binary_available":True,"chi_sim_available":True,
                                    "eng_available":True},
                    package_fn=lambda:"2.141.0",audit=True),data)
                with self.assertRaisesRegex(VisualGateError,"REPORT_EXISTS"):
                    target.execute(root,{},assets_fn=lambda r:inventory(),
                    ocr_fn=lambda:{"binary_available":True,"chi_sim_available":True,
                                    "eng_available":True},
                    package_fn=lambda:"2.141.0",write=True)

    def test_package_ocr_and_potential_cache_are_separate_states(self):
        missing={"binary_available":False,"chi_sim_available":False,
                 "eng_available":False}
        ready={"binary_available":True,"chi_sim_available":True,
               "eng_available":True}
        self.assertEqual(target.calculate_status(None,ready,inventory(2,1)),
                         "BLOCKED_DOCLING_VERSION")
        self.assertEqual(target.calculate_status("2.141.0",missing,inventory(2,1)),
                         "BLOCKED_TESSERACT_CHINESE_ENGLISH_OCR")
        self.assertEqual(target.calculate_status("2.141.0",ready,inventory(2,1)),
                         "CANDIDATE_ASSETS_ONLY_RUNTIME_UNVERIFIED")
        self.assertEqual(target.calculate_status("2.141.0",ready,inventory(1,0)),
                         "BLOCKED_STANDARD_MODEL_ARTIFACTS")

    def test_symlinks_and_unsafe_cache_never_inspected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            safe=root/"tool-env"/"docling-standard-artifacts"
            safe.parent.mkdir(parents=True)
            safe.symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(VisualGateError,"SYMLINK"):
                target.discover_assets(root)

    def test_source_tamper_and_wrong_physical_page_block_no_write(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,pdf,spatial,native=input_fixture(root)
            with self.contexts(folder,spatial,native):
                native["pages"][0]["physical_page"]=108
                with self.assertRaisesRegex(VisualGateError,"NOT_SAME_SOURCE_OR_PAGE"):
                    target.execute(root,{})
                native["pages"][0]["physical_page"]=109
                pdf.write_bytes(b"tampered")
                with self.assertRaisesRegex(VisualGateError,"STAGED_PDF_TAMPERED"):
                    target.execute(root,{})
                self.assertFalse((folder/target.REPORT).exists())

    def test_freeze_tamper_detected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,pdf,spatial,native=input_fixture(root)
            with self.contexts(folder,spatial,native):
                params=dict(assets_fn=lambda r:inventory(),
                            ocr_fn=lambda:{"binary_available":False,
                                           "chi_sim_available":False,
                                           "eng_available":False},
                            package_fn=lambda:"2.141.0")
                target.execute(root,{},write=True,**params)
                (folder/target.REPORT).write_text("{}",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"READINESS_CHANGED"):
                    target.execute(root,{},audit=True,**params)


if __name__=="__main__":
    unittest.main()
