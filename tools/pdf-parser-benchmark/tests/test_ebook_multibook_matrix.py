"""Synthetic six-PDF 24-page + five-book OCR benchmark without real book bytes."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace

import fitz
import cv2
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_multibook_native_matrix as native
import ebook_multibook_rapidocr_matrix as ocr

def fixture(root):
    (root/"semantic_gate").mkdir()
    source=[]
    for i,book in enumerate(native.TARGETS):
        pdf=fitz.open()
        for j in range(4):
            page=pdf.new_page(width=240,height=180)
            page.insert_text((18,35),f"SYNTHETIC TEST {i} {j}",fontsize=14)
            page.draw_line((22,70),(210,110))
        content=pdf.tobytes()
        pdf.close()
        (root/f"synthetic_{book}.pdf").write_bytes(content)
        source.append({
            "id":book,"format":"pdf","size":len(content),
            "sha256":hashlib.sha256(content).hexdigest(),
            "total_physical_pages":4,
            "selected_physical_pages":[1,2,3,4],
            "ocr_physical_pages":[] if book=="B16" else [2],
        })
    return {"schema_version":1,"corpus_id":"SIX_SYNTHETIC_BOOKS_FOR_TESTS",
            "sources":source}


class FakeOCR:
    def __init__(self, empty=False):
        self.calls=0
        self.empty=empty
    def __call__(self,img):
        self.calls+=1
        if self.empty:
            return SimpleNamespace(boxes=None,txts=None,scores=None)
        return SimpleNamespace(
            boxes=np.array([[[15,15],[125,15],[125,43],[15,43]]]),
            txts=("合成图片文本",),scores=(.95,),
        )


PROBE=(dict(ocr.EXPECTED),{
    "det_model.onnx":"a"*64,
    "rec_model.onnx":"b"*64,
})


class MatrixTests(unittest.TestCase):
    def test_real_manifest_coverage_contract(self):
        # Fixture set may be synthetic, but real target IDs and 24-page
        # / 5-focus subset are invariant.
        with tempfile.TemporaryDirectory() as temp:
            m=fixture(Path(temp))
            selected=native.select_manifest(m)
            self.assertEqual(len(selected),6)
            self.assertEqual(sum(len(x["selected_physical_pages"]) for x in selected.values()),24)
            self.assertEqual(sum(bool(x["ocr_physical_pages"]) for x in selected.values()),5)

    def test_native_all_six_pdf_full_selected_pages(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=fixture(root)
            data=native.evaluate(root,manifest,fitz)
            self.assertEqual(data["pdf_book_count"],6)
            self.assertEqual(data["selected_native_pages"],24)
            self.assertEqual(data["ocr_focus_image_count"],5)
            self.assertEqual(len(data["rows"]),6)
            self.assertFalse((root/"semantic_gate"/native.FOLDER).exists())
            self.assertIsNone(data["layout_quality_gold"])

    def test_native_first_write_and_readonly_sha_audit(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=fixture(root)
            before=[hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.glob("*.pdf"))]
            data=native.evaluate(root,manifest,fitz,write=True)
            self.assertEqual(native.audit_existing(root,manifest),data)
            folder=root/"semantic_gate"/native.FOLDER
            self.assertEqual(len(list(folder.glob("*.private.png"))),5)
            self.assertEqual(before,[hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.glob("*.pdf"))])
            with self.assertRaisesRegex(native.VisualGateError,"EXISTS"):
                native.evaluate(root,manifest,fitz,write=True)

    def test_manipulated_staged_image_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=fixture(root)
            native.evaluate(root,manifest,fitz,write=True)
            p=next((root/"semantic_gate"/native.FOLDER).glob("*.private.png"))
            p.write_bytes(p.read_bytes()+b"tamper")
            with self.assertRaisesRegex(native.VisualGateError,"CORRUPTED"):
                native.audit_existing(root,manifest)

    def test_manifest_duplicate_and_wrong_source_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=fixture(root)
            m=json.loads(json.dumps(manifest))
            m["sources"].append(m["sources"][0])
            with self.assertRaisesRegex(native.VisualGateError,"DUPLICATE"):
                native.select_manifest(m)
            m=json.loads(json.dumps(manifest))
            m["sources"][0]["sha256"]="f"*64
            with self.assertRaisesRegex(native.VisualGateError,"INCOMPLETE"):
                native.evaluate(root,m,fitz)

    def test_offline_ocr_real_five_original_staged_pngs(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=fixture(root)
            native.evaluate(root,manifest,fitz,write=True)
            engine=FakeOCR()
            data=ocr.execute(root,manifest,cv2,np,engine=engine,probe=PROBE)
            self.assertEqual(engine.calls,5)
            self.assertEqual(len(data["pages"]),5)
            self.assertEqual(data["ocr_books"],5)
            self.assertEqual(sum(p["rapidocr_char_count"] for p in data["pages"]),5*len("合成图片文本"))
            self.assertFalse((root/"semantic_gate"/native.FOLDER/ocr.REPORT).exists())
            self.assertIsNone(data["ocr_accuracy_gold"])

    def test_private_ocr_first_write_sha_integrity_and_no_gold(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=fixture(root)
            native.evaluate(root,manifest,fitz,write=True)
            data=ocr.execute(root,manifest,cv2,np,engine=FakeOCR(),probe=PROBE,write=True)
            self.assertEqual(ocr.audit_existing(root,manifest),data)
            self.assertEqual(data["provider_calls"],0)
            self.assertIsNone(data["graph_accuracy_gold"])
            with self.assertRaisesRegex(ocr.VisualGateError,"NO_REPEAT"):
                ocr.execute(root,manifest,cv2,np,engine=FakeOCR(),probe=PROBE,write=True)

    def test_text_tamper_same_length_is_detected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=fixture(root)
            native.evaluate(root,manifest,fitz,write=True)
            ocr.execute(root,manifest,cv2,np,engine=FakeOCR(),probe=PROBE,write=True)
            file=root/"semantic_gate"/native.FOLDER/ocr.REPORT
            obj=json.loads(file.read_text("utf-8"))
            obj["pages"][0]["rapidocr_private_rows"][0]["text"]="相同长度文字"
            file.write_text(json.dumps(obj,ensure_ascii=False),encoding="utf-8")
            with self.assertRaisesRegex(ocr.VisualGateError,"TAMPERED"):
                ocr.audit_existing(root,manifest)

    def test_missing_or_fake_gold_is_not_promoted(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=fixture(root)
            native.evaluate(root,manifest,fitz,write=True)
            ocr.execute(root,manifest,cv2,np,engine=FakeOCR(),probe=PROBE,write=True)
            file=root/"semantic_gate"/native.FOLDER/ocr.REPORT
            obj=json.loads(file.read_text("utf-8"))
            obj["graph_accuracy_gold"]=1
            file.write_text(json.dumps(obj),encoding="utf-8")
            with self.assertRaisesRegex(ocr.VisualGateError,"PROVENANCE_INVALID"):
                ocr.audit_existing(root,manifest)

    def test_empty_ocr_result_not_a_quality_failure_or_zero_truth(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=fixture(root)
            native.evaluate(root,manifest,fitz,write=True)
            data=ocr.execute(root,manifest,cv2,np,engine=FakeOCR(empty=True),probe=PROBE)
            self.assertEqual(data["ocr_books"],5)
            self.assertEqual(sum(p["rapidocr_line_count"] for p in data["pages"]),0)
            self.assertIsNone(data["ocr_accuracy_gold"])

    def test_original_source_file_missing_is_hard_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);manifest=fixture(root)
            (root/"synthetic_B31.pdf").unlink()
            with self.assertRaisesRegex(native.VisualGateError,"INCOMPLETE"):
                native.evaluate(root,manifest,fitz,write=True)
            self.assertFalse((root/"semantic_gate"/native.FOLDER).exists())


if __name__=="__main__":
    unittest.main()
