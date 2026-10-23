"""Synthetic RapidOCR 3.9.2 isolated real-page contract: no cloud, no gold."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace

import cv2
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b31_rapidocr_isolated as subject
from test_ebook_b31_offline_ocr import prepare, MANIFEST

PROBE=(dict(subject.EXPECTED),{
    "PP-OCRv6_det_small.onnx":"a"*64,
    "PP-OCRv6_rec_small.onnx":"b"*64,
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx":"c"*64,
})


class Fake:
    def __init__(self, result=None):
        self.calls=0
        self.result=result if result is not None else SimpleNamespace(
            boxes=np.array([[[5,10],[105,10],[105,28],[5,28]]]),
            txts=("样本节点","右侧文本"),
            scores=(.94,.83),
        )

    def __call__(self, image):
        self.calls += 1
        assert image.shape == (160,240,3)
        return self.result


def success():
    return Fake(SimpleNamespace(
        boxes=np.array([
            [[10,10],[95,10],[95,35],[10,35]],
            [[110,70],[230,70],[230,95],[110,95]],
        ]),
        txts=("左侧", "右侧"), scores=(0.92,0.87),
    ))


class RapidOcrRealSourceTests(unittest.TestCase):
    def test_modern_output_bundled_ocr_source_rows(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder=prepare(root)
            secret=folder/"visual_graph_proposal_B31.candidate.private.json"
            secret.write_text("NEVER_READ_GLM",encoding="utf-8")
            engine=success()
            result=subject.run(root,MANIFEST,cv2,np,engine=engine,probe=PROBE)
            self.assertEqual(engine.calls,1)
            self.assertEqual(result["recognized_line_count"],2)
            self.assertEqual(result["private_source_ocr_rows"][0]["text"],"左侧")
            self.assertFalse(result["arrow_direction_verified"])
            self.assertEqual(result["provider_calls"],0)
            self.assertEqual(secret.read_text(),"NEVER_READ_GLM")

    def test_empty_real_model_output_not_fake_empty_gold(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);prepare(root)
            engine=Fake(SimpleNamespace(boxes=None,txts=None,scores=None))
            result=subject.run(root,MANIFEST,cv2,np,engine=engine,probe=PROBE)
            self.assertEqual(result["recognized_line_count"],0)
            self.assertIsNone(result["ocr_quality_gold"])

    def test_partial_fields_and_cardinality_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);prepare(root)
            for fake in (
                Fake(SimpleNamespace(boxes=[],txts=("文字",),scores=())),
                Fake(SimpleNamespace(boxes=None,txts=("文字",),scores=(.8,))),
            ):
                with self.assertRaises(subject.VisualGateError):
                    subject.run(root,MANIFEST,cv2,np,engine=fake,probe=PROBE)

    def test_invalid_bundled_versions_rejected_before_engine(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);prepare(root)
            engine=success()
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.run(root,MANIFEST,cv2,np,engine=engine,
                            probe=({"rapidocr":"3.10.0","onnxruntime":"1.22.1"},PROBE[1]))
            self.assertEqual(engine.calls,0)

    def test_first_private_write_audit_and_exclusive(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder=prepare(root)
            before=(folder/"b31_source_only_page126.private.png").read_bytes()
            record=subject.run(root,MANIFEST,cv2,np,engine=success(),
                               probe=PROBE,write=True)
            self.assertEqual(subject.audit_existing(root,MANIFEST),record)
            self.assertEqual((folder/"b31_source_only_page126.private.png").read_bytes(),before)
            with self.assertRaisesRegex(subject.VisualGateError,"EXISTS"):
                subject.run(root,MANIFEST,cv2,np,engine=success(),
                            probe=PROBE,write=True)

    def test_forged_gold_fails_audit(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder=prepare(root)
            subject.run(root,MANIFEST,cv2,np,engine=success(),probe=PROBE,write=True)
            output=folder/subject.OUT
            x=json.loads(output.read_text(encoding="utf-8"))
            x["certified_graph_f1"]=1
            output.write_text(json.dumps(x,ensure_ascii=False),encoding="utf-8")
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.audit_existing(root,MANIFEST)

    def test_private_text_tampering_fails_audit(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder=prepare(root)
            subject.run(root,MANIFEST,cv2,np,engine=success(),probe=PROBE,write=True)
            output=folder/subject.OUT
            x=json.loads(output.read_text(encoding="utf-8"))
            x["private_source_ocr_rows"][0]["text"]="文字已篡改"
            output.write_text(json.dumps(x,ensure_ascii=False),encoding="utf-8")
            with self.assertRaisesRegex(subject.VisualGateError,"COUNT_MISMATCH"):
                subject.audit_existing(root,MANIFEST)

    def test_corrupted_source_png_sha_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);folder=prepare(root)
            png=folder/"b31_source_only_page126.private.png"
            png.write_bytes(png.read_bytes()+b"evil")
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.run(root,MANIFEST,cv2,np,engine=success(),probe=PROBE)

    def test_missing_root_does_not_create_private_folder(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with self.assertRaises(subject.VisualGateError):
                subject.run(root,MANIFEST,cv2,np,engine=success(),probe=PROBE,write=True)
            self.assertFalse((root/"semantic_gate").exists())

    def test_invalid_result_scores_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);prepare(root)
            fake=Fake(SimpleNamespace(
                boxes=[[[0,0],[20,0],[20,20],[0,20]]],
                txts=("好的",),scores=(float("nan"),)))
            with self.assertRaises(subject.VisualGateError):
                subject.run(root,MANIFEST,cv2,np,engine=fake,probe=PROBE)


if __name__=="__main__":
    unittest.main()
