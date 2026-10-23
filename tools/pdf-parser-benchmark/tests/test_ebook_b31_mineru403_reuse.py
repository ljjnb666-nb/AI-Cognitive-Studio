"""Synthetic actual same-page stage and historical local MinerU resource guards."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import fitz

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_multibook_native_matrix as native
import ebook_multibook_docling_native as docling
import ebook_b31_mineru403_reuse as mineru
from test_ebook_multibook_matrix import fixture
from test_ebook_multibook_docling_native import NativeFakeConverter


def prepare(root):
    manifest=fixture(root)
    entry=next(x for x in manifest["sources"] if x["id"]=="B31")
    path=root/"synthetic_B31.pdf"
    pdf=fitz.open()
    for n in range(378):
        page=pdf.new_page(width=240,height=180)
        if n in (14,125,251,377):
            page.insert_text((15,35),"SYNTHETIC not copyrighted",fontsize=11)
    raw=pdf.tobytes()
    pdf.close()
    path.write_bytes(raw)
    entry["size"]=len(raw)
    entry["sha256"]=hashlib.sha256(raw).hexdigest()
    entry["total_physical_pages"]=378
    entry["selected_physical_pages"]=[15,126,252,378]
    entry["ocr_physical_pages"]=[126,252]
    native.evaluate(root,manifest,fitz,write=True)
    docling.execute(root,manifest,fitz,converter=NativeFakeConverter(),write=True)
    return manifest


def create_cached_runtime(root):
    exe=root/"python"/"mineru"/"Scripts"/"mineru.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"test mineru executable")
    model=root/"cache"/"mineru"/"home"/"models"/mineru.MODEL_SUBDIR
    model.mkdir(parents=True)
    # Sparse ONNX fixtures: 5 entries totaling >100MiB; nothing downloaded.
    for index in range(5):
        with (model/f"sample_{index}.onnx").open("wb") as f:
            f.truncate(21_000_000)
    return exe,model


def runner_success(command,env,logfile):
    assert env["MINERU_MODEL_SOURCE"]=="local"
    assert env["HF_HUB_OFFLINE"]=="1"
    assert env["HTTP_PROXY"].endswith(":1")
    assert "--pages" in command and command[command.index("--pages")+1]=="all"
    assert "--tier" in command and command[command.index("--tier")+1]=="flash"
    assert "--json" not in command and "--force" not in command
    output=Path(command[command.index("--output")+1])
    output.write_text("# mock private MinerU result\n\nnot gold\n",encoding="utf-8")
    return 0


class MineruReuseTests(unittest.TestCase):
    def test_real_24_page_baseline_selects_same_original_B31_126(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            manifest=prepare(root)
            stage,baseline,doc=mineru.find_source(root,manifest)
            self.assertEqual(doc["physical_page"],126)
            self.assertEqual(doc["staged_pdf_sha256"],mineru.sha_file(stage))
            with fitz.open(stage) as pdf:
                self.assertEqual(pdf.page_count,1)

    def test_no_executable_models_no_fake_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=prepare(root)
            with self.assertRaisesRegex(mineru.VisualGateError,"RUNTIME_OR_CACHE_MISSING"):
                mineru.capture(root,manifest)
            self.assertFalse((root/"semantic_gate"/native.FOLDER/mineru.REPORT).exists())

    def test_preflight_does_not_modify_any_staged_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=prepare(root)
            create_cached_runtime(root)
            stage,_,_=mineru.find_source(root,manifest)
            before=mineru.sha_file(stage)
            result=mineru.capture(root,manifest)
            self.assertEqual(result["page"],126)
            self.assertFalse(result["actual_inference"])
            self.assertEqual(result["cached_onnx_weight_count"],5)
            self.assertEqual(before,mineru.sha_file(stage))

    def test_reuse_true_private_inference_one_time_and_readback(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=prepare(root)
            create_cached_runtime(root)
            report=mineru.capture(root,manifest,write=True,runner=runner_success)
            self.assertTrue(report["actual_inference"])
            self.assertEqual(report["model_file_count"],5)
            self.assertEqual(report["provider_calls"],0)
            self.assertEqual(report["model_downloads"],0)
            self.assertIsNone(report["graph_quality_gold"])
            self.assertEqual(mineru.audit_existing(root,manifest),report)
            with self.assertRaisesRegex(mineru.VisualGateError,"PARTIAL_OUTPUT_EXISTS"):
                mineru.capture(root,manifest,write=True,runner=runner_success)

    def test_failure_creates_log_but_no_false_success_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=prepare(root)
            create_cached_runtime(root)
            with self.assertRaisesRegex(mineru.VisualGateError,"INFERENCE_FAILED"):
                mineru.capture(root,manifest,write=True,
                               runner=lambda command,env,log:6)
            folder=root/"semantic_gate"/native.FOLDER
            self.assertFalse((folder/mineru.REPORT).exists())
            self.assertTrue((folder/mineru.PRIVATE_LOG).exists())
            with self.assertRaisesRegex(mineru.VisualGateError,"PARTIAL_OUTPUT_EXISTS"):
                mineru.capture(root,manifest,write=True,runner=runner_success)


if __name__=="__main__":
    unittest.main()
