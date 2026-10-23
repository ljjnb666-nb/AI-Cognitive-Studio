"""Synthetic B31 original-page OCR: no cloud, identity, privacy and integrity."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b31_offline_ocr as target

PDF_SHA="b"*64
MANIFEST={"sources":[
    {"id":"B15","size":10,"sha256":"a"*64,"total_physical_pages":438},
    {"id":"B31","size":30,"sha256":PDF_SHA,"total_physical_pages":504},
]}


def prepare(root):
    folder=root/"semantic_gate"
    folder.mkdir()
    img=np.full((160,240,3),255,np.uint8)
    cv2.rectangle(img,(12,25),(210,90),(0,0,0),2)
    success,png=cv2.imencode(".png",img)
    assert success
    binary=png.tobytes()
    (folder/"b31_source_only_page126.private.png").write_bytes(binary)
    (folder/"b31_source_only_page126.private.json").write_text(json.dumps({
        "schema_version":1,"book_id":"B31","physical_page":126,
        "source_document_sha256":PDF_SHA,
        "private_png_sha256":hashlib.sha256(binary).hexdigest(),
        "provenance":"PDF_NATIVE_INDEPENDENT_OF_GLM_PREDICTION",
        "render_width":240,"render_height":160,
        "human_verified":False,"certified_graph_f1":None,
    }),encoding="utf-8")
    return folder


class Engine:
    def __init__(self, observations=None):
        self.calls=0
        self.observations=observations or [
            ([[12,25],[102,25],[102,51],[12,51]],"模拟节点",0.932),
            ([[110,50],[214,50],[214,90],[110,90]],"第二个点",0.822),
        ]

    def __call__(self,bgr):
        self.calls+=1
        assert bgr.shape==(160,240,3)
        return (self.observations,0.12)


class OfflineOcrTests(unittest.TestCase):
    def test_local_bundled_engine_recognition_stays_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=prepare(root)
            model=folder/"visual_graph_proposal_B31.candidate.private.json"
            model.write_text("GLM_PRIVATE_MODEL_NOT_FOR_OCR",encoding="utf-8")
            engine=Engine()
            record=target.analyze(root,MANIFEST,cv2,np,engine=engine,
                                  availability=(True,"BUNDLED_MODELS_PRESENT"))
            self.assertEqual(engine.calls,1)
            self.assertEqual(record["recognized_line_count"],2)
            self.assertEqual(record["outcome"],"OFFLINE_OCR_OBSERVATION")
            self.assertEqual(record["recognized_private_lines"][0]["text"],"模拟节点")
            self.assertFalse((folder/target.OUT).exists())
            self.assertEqual(model.read_text(),"GLM_PRIVATE_MODEL_NOT_FOR_OCR")
            self.assertIsNone(record["independent_graph_gold"])

    def test_no_bundled_weights_is_explicit_unavailable_not_fabricated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=prepare(root)
            engine=Engine()
            result=target.analyze(root,MANIFEST,cv2,np,engine=engine,
                                  availability=(False,"BUNDLED_DET_REC_WEIGHTS_NOT_FOUND"))
            self.assertEqual(engine.calls,0)
            self.assertEqual(result["outcome"],"NO_OFFLINE_OCR_ENGINE")
            self.assertEqual(result["recognized_line_count"],0)
            self.assertEqual(result["recognized_private_lines"],[])

    def test_private_write_exclusive_and_readback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=prepare(root)
            raw=(folder/"b31_source_only_page126.private.png").read_bytes()
            report=target.analyze(root,MANIFEST,cv2,np,engine=Engine(),
                                  availability=(True,"BUNDLED_MODELS_PRESENT"),write=True)
            self.assertEqual(target.audit_existing(root,MANIFEST),report)
            self.assertEqual((folder/"b31_source_only_page126.private.png").read_bytes(),raw)
            with self.assertRaisesRegex(target.VisualGateError,"ALREADY_EXISTS"):
                target.analyze(root,MANIFEST,cv2,np,engine=Engine(),
                               availability=(True,"BUNDLED_MODELS_PRESENT"),write=True)

    def test_numpy_quad_is_accepted_with_strict_finite_values(self):
        rows=target.parse_results([(np.array([[0,0],[10,0],[10,12],[0,12]]),
                                    "测试",0.78)],240,160)
        self.assertEqual(rows[0]["quad"][2],[10.,12.])

    def test_bad_coords_and_score_rejected(self):
        for row in (
            ([[1,1],[9,1],[9,-1],[1,9]],"foo",0.5),
            ([[1,1],[9,1],[9,9],[1,9]],"foo",float("nan")),
            ([[1,1],[9,1],[9,9],[1,9]],"foo",1.1),
            ([[1,1],[9,1],[9,9],[1,9]],"bad\x01",0.8),
        ):
            with self.subTest(row=row):
                with self.assertRaises(target.VisualGateError):
                    target.parse_results([row],240,160)

    def test_oversize_number_of_lines_fail_closed(self):
        row=([[1,1],[9,1],[9,9],[1,9]],"test",0.7)
        with self.assertRaisesRegex(target.VisualGateError,"LIMIT"):
            target.parse_results([row]*301,240,160)

    def test_corrupt_source_png_sha_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=prepare(root)
            path=folder/"b31_source_only_page126.private.png"
            path.write_bytes(path.read_bytes()+b"tampered")
            with self.assertRaisesRegex(target.VisualGateError,"PROVENANCE_INVALID"):
                target.analyze(root,MANIFEST,cv2,np,engine=Engine(),
                               availability=(True,"BUNDLED_MODELS_PRESENT"))

    def test_wrong_pdf_digest_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);prepare(root)
            m=json.loads(json.dumps(MANIFEST))
            m["sources"][1]["sha256"]="c"*64
            with self.assertRaisesRegex(target.VisualGateError,"PROVENANCE_INVALID"):
                target.analyze(root,m,cv2,np,availability=(False,"PACKAGE_NOT_INSTALLED"))

    def test_forged_gold_in_ocr_receipt_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=prepare(root)
            target.analyze(root,MANIFEST,cv2,np,engine=Engine(),
                           availability=(True,"BUNDLED_MODELS_PRESENT"),write=True)
            f=folder/target.OUT
            data=json.loads(f.read_text())
            data["arrow_direction_verified"]=True
            f.write_text(json.dumps(data),encoding="utf-8")
            with self.assertRaisesRegex(target.VisualGateError,"PROVENANCE_INVALID"):
                target.audit_existing(root,MANIFEST)

    def test_missing_private_source_no_output_created(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            with self.assertRaises(target.VisualGateError):
                target.analyze(root,MANIFEST,cv2,np,availability=(False,"PACKAGE_NOT_INSTALLED"),write=True)
            self.assertFalse((root/"semantic_gate").exists())


if __name__=="__main__":
    unittest.main()
