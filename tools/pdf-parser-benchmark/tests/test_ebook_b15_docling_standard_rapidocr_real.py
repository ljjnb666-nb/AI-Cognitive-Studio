"""No-model synthetic tests for real Docling Standard + RapidOCR candidate trial."""
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from contextlib import ExitStack

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b15_docling_standard_rapidocr_real as s
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    pdf=folder/"docling_native_single_pages"/"B15_p0109.private.pdf"
    pdf.parent.mkdir()
    pdf.write_bytes(b"PRIVATE_SYNTHETIC_NOT_REAL")
    sha=hashlib.sha256(pdf.read_bytes()).hexdigest()
    (folder/"b15_docling_standard_layout_real.v3.private.json").write_text(
        "PRIVATE_PRIOR_LAYOUT",encoding="utf-8")
    prior={"corpus_id":"SYNTHETIC"}
    base={"status":"REAL_STANDARD_LAYOUT_SUCCESS_OCR_DISABLED",
          "actual_layout_success":True,"same_page_sha256_private":sha,
          "ocr_page_count":0}
    model=root/"tool-env"/"docling-models"
    model.mkdir(parents=True)
    package=root/"tool-env"/"rapidocr-offline"/"Lib"/"site-packages"
    package.mkdir(parents=True)
    pkg={"site":package,"versions":dict(s.VERSIONS),
         "weights":{"det.onnx":"a"*64,"rec.onnx":"b"*64}}
    return folder,pdf,sha,prior,base,model,pkg


class RealStandardRapidTests(unittest.TestCase):
    def bind(self,folder,pdf,sha,prior,base,model):
        stack=ExitStack()
        stack.enter_context(patch.object(s,"verify_source",
            return_value=(folder,pdf,sha,prior,[("models",model)])))
        stack.enter_context(patch.object(s,"audit_layout",return_value=base))
        return stack

    def test_absent_and_ambiguous_existing_install_is_not_assumed_ready(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);f,pdf,sha,prior,base,model,pkg=fixture(root)
            with self.bind(f,pdf,sha,prior,base,model):
                info=s.compute(root,{},probe=lambda r:[])
                self.assertEqual(info["status"],
                    "BLOCKED_NO_OFFLINE_COMPATIBLE_RAPIDOCR_SITE_PACKAGES")
                self.assertFalse(info["actual_ocr_success"])
                self.assertEqual(info["new_cloud_calls"],0)
                info=s.compute(root,{},probe=lambda r:[pkg,pkg])
                self.assertEqual(info["status"],
                    "BLOCKED_MULTIPLE_COMPATIBLE_RAPIDOCR_ENVIRONMENTS")

    def test_frozen_success_receipt_only_when_real_worker_returns_success(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);f,pdf,sha,prior,base,model,pkg=fixture(root)
            def simulate_worker(argv,**kwargs):
                self.assertEqual(kwargs["env"]["HF_HUB_OFFLINE"],"1")
                self.assertEqual(kwargs["env"]["TRANSFORMERS_OFFLINE"],"1")
                self.assertEqual(kwargs["env"]["PYTHONPATH"],str(pkg["site"]))
                record={"pipeline":"REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU",
                        "ocr_explicitly_enabled":True,"duration_ms":4500,
                        "text_item_count":5,"picture_item_count":2,
                        "table_item_count":0,
                        "private_markdown":"## 机密文本0123"}
                s._exclusive(Path(argv[-1]),
                    json.dumps(record,ensure_ascii=False).encode("utf-8"))
                return SimpleNamespace(returncode=0,stdout=b"",stderr=b"PRIVATE_STDERR")
            with self.bind(f,pdf,sha,prior,base,model):
                info=s.compute(root,{},write=True,probe=lambda r:[pkg],
                               runner=simulate_worker)
                self.assertTrue(info["actual_ocr_success"])
                self.assertEqual(info["text_item_count"],5)
                self.assertEqual(info["status"],
                                 "REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS")
                self.assertIsNone(info["cer"])
                public_report=(f/s.REPORT).read_text("utf-8")
                self.assertNotIn("机密文本",public_report)
                self.assertNotIn("PRIVATE_STDERR",public_report)
                self.assertEqual(s.compute(root,{},audit=True),info)
                with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                    s.compute(root,{},write=True,probe=lambda r:[pkg])
                (f/s.WORKER).write_text("tampered",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"WORKER_CHANGED"):
                    s.compute(root,{},audit=True)

    def test_private_worker_error_preserves_log_not_accuracy_claims(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);f,pdf,sha,prior,base,model,pkg=fixture(root)
            def err(*args,**kwargs):
                return SimpleNamespace(returncode=9,stdout=b"",
                                       stderr=b"PRIVATE_OCR_STACKTRACE")
            with self.bind(f,pdf,sha,prior,base,model):
                data=s.compute(root,{},write=True,probe=lambda r:[pkg],runner=err)
                self.assertEqual(data["status"],
                    "BLOCKED_PRIVATE_STANDARD_OCR_RUNTIME_FAILURE")
                self.assertFalse(data["actual_ocr_success"])
                self.assertIsNone(data["markdown_normalized_character_count"])
                self.assertEqual(s.compute(root,{},audit=True),data)
                self.assertIn(b"PRIVATE_OCR_STACKTRACE",(f/s.LOG).read_bytes())
                self.assertNotIn("PRIVATE_OCR_STACKTRACE",
                                 (f/s.REPORT).read_text("utf-8"))

    def test_stale_layout_or_source_identity_refuses_new_report(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);f,pdf,sha,prior,base,model,pkg=fixture(root)
            with self.bind(f,pdf,sha,prior,base,model):
                base["status"]="BLOCKED_PRIVATE_ERROR"
                with self.assertRaisesRegex(VisualGateError,"BASELINE_NOT_PROVEN"):
                    s.compute(root,{},write=True,probe=lambda r:[pkg])
                self.assertFalse((f/s.REPORT).exists())

    def test_worker_package_discovery_requires_exact_both_versions(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);f,pdf,sha,prior,base,model,pkg=fixture(root)
            root_env=root/"tool-env"
            site=root_env/"rapidocr-offline"/"Lib"/"site-packages"
            # Dummy dist-info names are the only synthetic sources:
            for name,version in s.VERSIONS.items():
                package=site/(name+"-"+version+".dist-info")
                package.mkdir()
                (package/"METADATA").write_text(
                    "Metadata-Version: 2.1\nName: "+name+"\nVersion: "+version+"\n",
                    encoding="utf-8")
            model_dir=site/"rapidocr"/"models"
            model_dir.mkdir(parents=True)
            for suffix in ("det","rec"):
                (model_dir/("abc_"+suffix+".onnx")).write_bytes(b"x"*12000)
            ready=s.discover_existing_rapidocr(root)
            self.assertEqual(len(ready),1)
            self.assertEqual(ready[0]["versions"],s.VERSIONS)
            self.assertEqual(len(ready[0]["weights"]),2)


if __name__=="__main__":
    unittest.main()
