"""No-inference synthetic five-book Standard+RapidOCR receipts and source fences."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_fivebook_docling_standard_rapidocr_real as s
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    inputs=folder/"docling_native_single_pages"
    inputs.mkdir()
    entries={}
    for name,num in (("B03",67),("B08",64),("B15",109),
                     ("B29",72),("B31",126)):
        path=inputs/f"{name}_p{num:04d}.private.pdf"
        path.write_bytes((f"synthetic PDF {name}\n"*100).encode("utf-8"))
        entries[name]={"book_id":name,"physical_page":num,
                       "original_pdf_sha256":hashlib.sha256(
                           f"original-{name}".encode()).hexdigest(),
                       "single_pdf_sha256":hashlib.sha256(path.read_bytes()).hexdigest(),
                       "source_file":path}
    models=root/"tool-env"/"docling-models"
    models.mkdir(parents=True)
    site=root/"tool-env"/"ocr-v1"/"Lib"/"site-packages"
    site.mkdir(parents=True)
    pkg={"site":site,"versions":dict(s.VERSIONS),
         "weights":{"det.onnx":"a"*64,"rec.onnx":"b"*64}}
    base={"status":"REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS",
          "actual_ocr_success":True,
          "source_single_page_pdf_sha256_private":entries["B15"]["single_pdf_sha256"],
          "duration_ms":18140,"text_item_count":29,"picture_item_count":2,
          "table_item_count":0,"markdown_normalized_character_count":99,
          "cer":None}
    v6={"book_id":"B15","physical_page":109,"corpus_id":"TEST"}
    return folder,entries,models,pkg,base,v6


class MultiBookStdTests(unittest.TestCase):
    def bind_layout(self,folder,entries,models):
        return patch.object(s,"verified_b15_layout",return_value=(
            folder,entries["B15"]["source_file"],
            entries["B15"]["single_pdf_sha256"],{},[("model",models)]))

    def execute_stubbed(self,root,folder,entries,models,pkg,base,v6,
                        *,runner,write=False,audit=False):
        with self.bind_layout(folder,entries,models):
            return s.execute(root,{},write=write,audit=audit,
                source_fn=lambda r,m:(entries,None,None,folder,None,None,"TEST"),
                b15_fn=lambda r,m,audit:base,
                v6_fn=lambda r,m,audit:v6,
                probe=lambda r:[pkg],runner=runner)

    def test_real_four_queued_pages_and_reused_frozen_b15(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,entries,models,pkg,base,v6=fixture(root)
            calls=[]
            def fake_worker(cmd,**kwargs):
                self.assertEqual(kwargs["env"]["HF_HUB_OFFLINE"],"1")
                self.assertEqual(kwargs["env"]["TRANSFORMERS_OFFLINE"],"1")
                self.assertEqual(kwargs["env"]["PYTHONPATH"],str(pkg["site"]))
                self.assertEqual(kwargs["timeout"],s.MAX_RUNTIME)
                calls.append(Path(cmd[-1]).name)
                record={"pipeline":"REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU",
                        "ocr_explicitly_enabled":True,
                        "duration_ms":1100+len(calls),
                        "text_item_count":len(calls),
                        "picture_item_count":2,"table_item_count":0,
                        "private_markdown":"这是私有页码 不得外传"}
                s._exclusive(Path(cmd[-1]),
                    json.dumps(record,ensure_ascii=False).encode("utf-8"))
                return SimpleNamespace(returncode=0,stdout=b"",stderr=b"PRIVATE STDERR")
            data=self.execute_stubbed(root,folder,entries,models,pkg,base,v6,
                                      write=True,runner=fake_worker)
            self.assertEqual(len(calls),4)
            self.assertEqual(data["actual_standard_ocr_success_pages"],5)
            self.assertTrue(data["all_five_real_standard_ocr_succeeded"])
            self.assertEqual(data["rows"][0]["execution_basis"],
                             "B15_REUSED_FROZEN_V4_NO_NEW_OCR")
            self.assertEqual(data["rows"][0]["normalized_characters"],99)
            self.assertEqual([r["book_id"] for r in data["rows"]],
                             ["B15","B03","B08","B29","B31"])
            self.assertEqual(data,self.execute_stubbed(root,folder,entries,
                models,pkg,base,v6,audit=True,runner=lambda *a,**k:
                self.fail("audit must not invoke OCR")))
            self.assertEqual(len(calls),4)
            raw=(folder/s.REPORT).read_text(encoding="utf-8")
            self.assertNotIn("私有页码",raw)
            self.assertNotIn("PRIVATE STDERR",raw)
            with self.assertRaisesRegex(VisualGateError,"SUMMARY_ALREADY_EXISTS"):
                self.execute_stubbed(root,folder,entries,models,pkg,base,v6,
                                      write=True,runner=fake_worker)

    def test_one_failure_kept_private_not_called_success(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,entries,models,pkg,base,v6=fixture(root)
            count=[0]
            def runner(cmd,**kwargs):
                count[0]+=1
                if count[0]==2:
                    return SimpleNamespace(returncode=1,stdout=b"",
                                           stderr=b"PRIVATE FAILURE")
                content=json.dumps({
                    "pipeline":"REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU",
                    "ocr_explicitly_enabled":True,
                    "duration_ms":1000,"text_item_count":2,
                    "picture_item_count":1,"table_item_count":0,
                    "private_markdown":"私有甲乙",
                },ensure_ascii=False).encode("utf-8")
                s._exclusive(Path(cmd[-1]),content)
                return SimpleNamespace(returncode=0,stdout=b"",stderr=b"")
            x=self.execute_stubbed(root,folder,entries,models,pkg,base,v6,
                                   write=True,runner=runner)
            self.assertEqual(count[0],4)
            self.assertEqual(x["actual_standard_ocr_success_pages"],4)
            self.assertFalse(x["all_five_real_standard_ocr_succeeded"])
            self.assertEqual(x["rows"][2]["status"],
                             "BLOCKED_STANDARD_RAPIDOCR_REAL_RUNTIME_PRIVATE_ERROR")
            self.assertEqual(x["rows"][2]["normalized_characters"],None)
            self.assertNotIn("PRIVATE FAILURE",
                             (folder/s.REPORT).read_text("utf-8"))

    def test_source_single_pdf_mutation_blocks_before_runner(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,entries,models,pkg,base,v6=fixture(root)
            entries["B03"]["source_file"].write_bytes(b"mutated")
            with self.assertRaisesRegex(VisualGateError,"SINGLE_PAGE_PDF_CHANGED"):
                self.execute_stubbed(root,folder,entries,models,pkg,base,v6,
                    write=True,runner=lambda *a,**k:self.fail("must not run"))
            self.assertFalse((folder/s.REPORT).exists())

    def test_frozen_private_worker_tamper_detected(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,entries,models,pkg,base,v6=fixture(root)
            def runner(cmd,**kwargs):
                rec={"pipeline":"REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU",
                     "ocr_explicitly_enabled":True,"duration_ms":100,
                     "text_item_count":1,"picture_item_count":0,
                     "table_item_count":0,"private_markdown":"测试内容"}
                s._exclusive(Path(cmd[-1]),json.dumps(rec,ensure_ascii=False).encode())
                return SimpleNamespace(returncode=0,stdout=b"",stderr=b"")
            self.execute_stubbed(root,folder,entries,models,pkg,base,v6,
                                 write=True,runner=runner)
            worker=s.paths(folder,"B29")[1]
            worker.write_text("{}",encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError,"FROZEN_WORKER_TAMPERED"):
                self.execute_stubbed(root,folder,entries,models,pkg,base,v6,
                                     audit=True,runner=runner)

    def test_replay_preexisting_page_receipt_skips_model(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,entries,models,pkg,base,v6=fixture(root)
            counter=[]
            def runner(cmd,**kwargs):
                counter.append(1)
                rec={"pipeline":"REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU",
                     "ocr_explicitly_enabled":True,"duration_ms":200,
                     "text_item_count":1,"picture_item_count":0,
                     "table_item_count":0,"private_markdown":"甲乙"}
                s._exclusive(Path(cmd[-1]),json.dumps(rec,ensure_ascii=False).encode())
                return SimpleNamespace(returncode=0,stdout=b"",stderr=b"")
            first=self.execute_stubbed(root,folder,entries,models,pkg,base,v6,
                                       write=True,runner=runner)
            self.assertEqual(len(counter),4)
            (folder/s.REPORT).unlink()
            second=self.execute_stubbed(root,folder,entries,models,pkg,base,v6,
                write=True,runner=lambda *a,**k:self.fail("must not redo"))
            self.assertEqual(first,second)
            self.assertEqual(len(counter),4)


if __name__=="__main__":
    unittest.main()
