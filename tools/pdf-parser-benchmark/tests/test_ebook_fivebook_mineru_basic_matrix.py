"""Five-source identity and four synthetic stateless MinerU Basic single-page runs."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_fivebook_mineru_basic_matrix as target
import ebook_b31_mineru_markdown_structure as stats
from ebook_private_glm_visual_reference import VisualGateError


def setup(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    sub=folder/"docling_native_single_pages"
    sub.mkdir(parents=True)
    exe=root/"python"/"mineru"/"Scripts"/"mineru.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"stub")
    exe.with_name("mineru-kit.exe").write_bytes(b"stub kit")
    allbooks=target.ALL_BOOKS
    native_rows=[]; docrows=[]; rapidrows=[]
    b31sha=None; b31source=None
    for i,book in enumerate(allbooks):
        page=126 if book=="B31" else i+10
        raw=f"SIMULATED PDF BOOK={book} PAGE={page}".encode("utf-8")*10
        original=f"{i+1:064x}"
        pdf_hash=hashlib.sha256(raw).hexdigest()
        (sub/f"{book}_p{page:04d}.private.pdf").write_bytes(raw)
        pnghash=f"{i+10:064x}"
        native_rows.append({
            "book_id":book,"source_document_sha256":original,
            "pages":[{"physical_page":page,"ocr_focus_png":f"{book}.private.png",
                      "ocr_focus_png_sha256":pnghash}],
        })
        docrows.append({
            "book_id":book,"physical_page":page,
            "original_pdf_sha256":original,"staged_pdf_sha256":pdf_hash,
        })
        rapidrows.append({
            "book_id":book,"physical_page":page,
            "source_document_sha256":original,
            "render_png_sha256":pnghash,
            "rapidocr_line_count":20+i,"rapidocr_char_count":110+i,
            "duration_ms":15+i,
        })
        if book=="B31":
            b31sha=pdf_hash;b31source=original
    fixture={
        "native":{"rows":native_rows,"selected_native_pages":24,"corpus_id":"SYNTHETIC"},
        "docling":{"pages":docrows,"docling_native_completed_pages":24},
        "rapid":{"pages":rapidrows,"ocr_books":5,"ocr_pages":5},
        "b31":{"real_inference":True,"source_page_sha256":b31sha,
               "source_document_sha256":b31source,"duration_ms":17263},
        "structure":{"new_model_inference_calls":0,
                     "mineru":stats.count_structure("# Synthetic B31\n![x](data:image/png;base64,AAAA)")},
        "triage":{"basic_model_probe":{"basic_models_verified":True}},
        "models":{"small_model.onnx":"f"*64},
    }
    return folder,exe,fixture


def runner(command,env,log):
    assert "--tier" in command and command[command.index("--tier")+1]=="basic"
    assert "--ocr-mode" in command and command[command.index("--ocr-mode")+1]=="ocr"
    assert "--json" not in command and "--force" not in command
    assert env["MINERU_MODEL_SOURCE"]=="local"
    assert env["MINERU_MODEL_SMALL_BACKEND"]=="onnx"
    assert env["HTTP_PROXY"]=="http://127.0.0.1:1"
    md=Path(command[command.index("-o")+1])
    md.write_text("# SYNTHETIC\n\nabc ![a](data:image/png;base64,QUJD)",encoding="utf-8")
    log.write_text("private fake completion",encoding="utf-8")
    return 0


class FiveBookTests(unittest.TestCase):
    def patch_sources(self,root,fixture,exe,folder):
        return mock.patch.multiple(target,
            audit_native=mock.DEFAULT,
            audit_docling=mock.DEFAULT,
            audit_rapidocr=mock.DEFAULT,
            audit_b31=mock.DEFAULT,
            audit_b31_structure=mock.DEFAULT,
            audit_model_verify=mock.DEFAULT,
            cache_inventory=mock.DEFAULT,
            _private_folder=mock.DEFAULT)

    def all_patches(self,root,fixture,exe,folder):
        from contextlib import ExitStack
        stack=ExitStack()
        for name,content in [
            ("audit_native",fixture["native"]),("audit_docling",fixture["docling"]),
            ("audit_rapidocr",fixture["rapid"]),("audit_b31",fixture["b31"]),
            ("audit_b31_structure",fixture["structure"]),
            ("audit_model_verify",fixture["triage"]),
        ]:
            stack.enter_context(mock.patch.object(target,name,return_value=content))
        stack.enter_context(mock.patch.object(target,"cache_inventory",
                  return_value=(exe,None,fixture["models"])))
        stack.enter_context(mock.patch.object(target,"_private_folder",
                  return_value=folder))
        return stack

    def test_exact_five_focus_sources_and_reused_B31(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,exe,data=setup(root)
            with self.all_patches(root,data,exe,folder):
                index,kit,models,d,old,structure,corpus=target.source_contract(root,{})
                self.assertEqual(set(index),set(target.ALL_BOOKS))
                self.assertEqual(index["B31"]["physical_page"],126)
                self.assertEqual(kit,exe.with_name("mineru-kit.exe"))

    def test_four_real_action_attempts_reuse_B31_without_new_call(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,exe,data=setup(root)
            calls=[]
            def counted(cmd,env,log):
                calls.append(cmd)
                return runner(cmd,env,log)
            with self.all_patches(root,data,exe,folder):
                for book in target.BOOKS:
                    before=target.run_book(root,{},book)
                    self.assertFalse(before["actual_inference"])
                    result=target.run_book(root,{},book,write=True,runner=counted)
                    self.assertTrue(result["real_inference"])
                    self.assertEqual(target.audit_book(root,{},book),result)
                self.assertEqual(len(calls),4)
                self.assertNotIn("B31",str(calls))
                summary=target.combined(root,{},write=True)
                self.assertEqual(summary["identical_focus_pages"],5)
                self.assertEqual(summary["new_mineru_inferences"],4)
                self.assertTrue(summary["b31_mineru_result_reused"])
                self.assertEqual(target.combined(root,{},audit=True),summary)
                self.assertEqual([x["book_id"] for x in summary["rows"]],
                                 list(target.ALL_BOOKS))
                self.assertIsNone(summary["ocr_quality_gold"])

    def test_failure_leaves_partial_log_and_never_forges_success(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,exe,data=setup(root)
            with self.all_patches(root,data,exe,folder):
                def fail(cmd,env,log):
                    log.write_text("PRIVATE first failure",encoding="utf-8")
                    return 9
                with self.assertRaisesRegex(VisualGateError,"INFERENCE_FAILED"):
                    target.run_book(root,{},"B03",write=True,runner=fail)
                receipt,md,log=target._data_path(folder,"B03")
                self.assertFalse(receipt.exists())
                self.assertEqual(log.read_text(),"PRIVATE first failure")
                with self.assertRaisesRegex(VisualGateError,"PARTIAL_EXISTS"):
                    target.run_book(root,{},"B03",write=True,runner=runner)

    def test_missing_or_changed_single_pdf_prevents_inference(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,exe,data=setup(root)
            with self.all_patches(root,data,exe,folder):
                file=folder/"docling_native_single_pages"/"B15_p0012.private.pdf"
                file.write_bytes(b"tampered")
                with self.assertRaisesRegex(VisualGateError,"SHA_MISMATCH"):
                    target.run_book(root,{},"B15",write=True,runner=runner)
                self.assertFalse((folder/target.file_names("B15")[0]).exists())

    def test_metadata_forgery_and_md_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,exe,data=setup(root)
            with self.all_patches(root,data,exe,folder):
                target.run_book(root,{},"B08",write=True,runner=runner)
                receipt,md,log=target._data_path(folder,"B08")
                md.write_text(md.read_text("utf-8")+"bad",encoding="utf-8")
                with self.assertRaises(VisualGateError):
                    target.audit_book(root,{},"B08")
                target.run_book(root,{},"B03",write=True,runner=runner)
                receipt,md,log=target._data_path(folder,"B03")
                obj=json.loads(receipt.read_text("utf-8"))
                obj["ocr_quality_gold"]={"cer":0}
                receipt.write_text(json.dumps(obj),encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"PROVENANCE_INVALID"):
                    target.audit_book(root,{},"B03")

    def test_missing_one_of_four_blocks_final_summary(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,exe,data=setup(root)
            with self.all_patches(root,data,exe,folder):
                for book in target.BOOKS[:3]:
                    target.run_book(root,{},book,write=True,runner=runner)
                with self.assertRaisesRegex(VisualGateError,"RESULT_MISSING"):
                    target.combined(root,{},write=True)
                self.assertFalse((folder/target.SUMMARY).exists())

    def test_wrong_book_or_b31_cannot_be_reinferred(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder,exe,data=setup(root)
            with self.all_patches(root,data,exe,folder):
                for wrong in ("B31","B16","OTHER"):
                    with self.subTest(book=wrong):
                        with self.assertRaises(VisualGateError):
                            target.run_book(root,{},wrong,write=True,runner=runner)


if __name__=="__main__":
    unittest.main()
