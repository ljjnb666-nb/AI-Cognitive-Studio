"""Synthetic Docling NativePdfPipeline 24 true page inputs: model-free only."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace

import fitz

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_multibook_native_matrix as baseline
import ebook_multibook_docling_native as target
from test_ebook_multibook_matrix import fixture


class FakeDocument:
    def __init__(self, content):
        self.texts=[1,2]
        self.pictures=[]
        self._content=content
    def export_to_markdown(self):
        return self._content


class NativeFakeConverter:
    def __init__(self, failed=False):
        self.calls=[]
        self.failed=failed
    def convert(self,pdf):
        with fitz.open(pdf) as doc:
            assert doc.page_count==1
            text=doc[0].get_text("text")
            self.calls.append(text)
            return SimpleNamespace(
                status=SimpleNamespace(name="FAILURE" if self.failed else "SUCCESS"),
                document=FakeDocument(text),
            )


class DoclingNativeTests(unittest.TestCase):
    def prepare(self):
        tmp=tempfile.TemporaryDirectory()
        root=Path(tmp.name)
        manifest=fixture(root)
        baseline.evaluate(root,manifest,fitz,write=True)
        return tmp,root,manifest

    def test_same_six_pdf_24_original_physical_pages(self):
        tmp,root,manifest=self.prepare()
        with tmp:
            rows,stage=target.build_pages(root,manifest,fitz)
            self.assertEqual(len(rows),24)
            self.assertEqual(len(stage),24)
            self.assertEqual({r["book_id"] for r in rows},set(target.TARGETS))
            for src in stage.values():
                with fitz.open(stream=src,filetype="pdf") as doc:
                    self.assertEqual(doc.page_count,1)

    def test_no_write_preview_never_leaves_single_page_pdf_or_report(self):
        tmp,root,manifest=self.prepare()
        with tmp:
            engine=NativeFakeConverter()
            report=target.execute(root,manifest,fitz,converter=engine)
            self.assertEqual(len(engine.calls),24)
            self.assertEqual(report["docling_native_completed_pages"],24)
            self.assertTrue(report["model_free"])
            self.assertFalse(report["actual_docling_standard_pipeline_tested"])
            self.assertIsNone(report["layout_quality_gold"])
            folder=root/"semantic_gate"/baseline.FOLDER
            self.assertFalse((folder/target.REPORT).exists())
            self.assertFalse((folder/target.PDF_SUBDIR).exists())

    def test_exclusive_staging_and_private_readback(self):
        tmp,root,manifest=self.prepare()
        with tmp:
            source={f.name:hashlib.sha256(f.read_bytes()).hexdigest()
                    for f in root.glob("*.pdf")}
            engine=NativeFakeConverter()
            report=target.execute(root,manifest,fitz,converter=engine,write=True)
            self.assertEqual(len(list((root/"semantic_gate"/baseline.FOLDER/
                                       target.PDF_SUBDIR).glob("*.private.pdf"))),24)
            self.assertEqual(target.audit_existing(root,manifest),report)
            self.assertEqual(source,{f.name:hashlib.sha256(f.read_bytes()).hexdigest()
                                     for f in root.glob("*.pdf")})
            with self.assertRaisesRegex(target.VisualGateError,"EXISTS"):
                target.execute(root,manifest,fitz,converter=engine,write=True)

    def test_pdf_bytes_modified_after_write_rejected(self):
        tmp,root,manifest=self.prepare()
        with tmp:
            target.execute(root,manifest,fitz,converter=NativeFakeConverter(),write=True)
            file=next((root/"semantic_gate"/baseline.FOLDER/
                       target.PDF_SUBDIR).glob("*.private.pdf"))
            file.write_bytes(file.read_bytes()+b"extra")
            with self.assertRaisesRegex(target.VisualGateError,"TAMPERED"):
                target.audit_existing(root,manifest)

    def test_equal_length_private_text_tampering_rejected(self):
        tmp,root,manifest=self.prepare()
        with tmp:
            target.execute(root,manifest,fitz,converter=NativeFakeConverter(),write=True)
            file=root/"semantic_gate"/baseline.FOLDER/target.REPORT
            data=json.loads(file.read_text("utf-8"))
            source=data["pages"][0]["private_markdown_text"]
            data["pages"][0]["private_markdown_text"]="X"+source[1:]
            file.write_text(json.dumps(data,ensure_ascii=False),encoding="utf-8")
            with self.assertRaisesRegex(target.VisualGateError,"TAMPERED"):
                target.audit_existing(root,manifest)

    def test_fail_conversion_does_not_create_gold_or_report(self):
        tmp,root,manifest=self.prepare()
        with tmp:
            with self.assertRaisesRegex(target.VisualGateError,"NOT_SUCCESS"):
                target.execute(root,manifest,fitz,converter=NativeFakeConverter(failed=True))
            self.assertFalse((root/"semantic_gate"/baseline.FOLDER/target.REPORT).exists())

    def test_cross_book_missing_fails_before_any_commit(self):
        tmp,root,manifest=self.prepare()
        with tmp:
            (root/"synthetic_B29.pdf").unlink()
            with self.assertRaises(target.VisualGateError):
                target.execute(root,manifest,fitz,converter=NativeFakeConverter(),write=True)
            self.assertFalse((root/"semantic_gate"/baseline.FOLDER/target.REPORT).exists())

    def test_fake_quality_claim_is_not_accepted(self):
        tmp,root,manifest=self.prepare()
        with tmp:
            target.execute(root,manifest,fitz,converter=NativeFakeConverter(),write=True)
            file=root/"semantic_gate"/baseline.FOLDER/target.REPORT
            data=json.loads(file.read_text("utf-8"))
            data["layout_quality_gold"]={"f1":1}
            file.write_text(json.dumps(data),encoding="utf-8")
            with self.assertRaisesRegex(target.VisualGateError,"PROVENANCE_INVALID"):
                target.audit_existing(root,manifest)


if __name__=="__main__":
    unittest.main()
