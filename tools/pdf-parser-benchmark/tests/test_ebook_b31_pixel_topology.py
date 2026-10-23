"""No-model B31 connected-ink source review: positive/negative and SHA gates."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ebook_b31_pixel_topology as subject
import ebook_b31_vtip_clutter_triage as triage
import ebook_b31_wing_continuity_controls as wings
from test_ebook_b31_vtip_clutter_triage import fixture, MANIFEST
from test_ebook_b31_multiscale_vtip_review import synthetic


def pixel_mask(png):
    image=cv2.imdecode(np.frombuffer(png,np.uint8),cv2.IMREAD_GRAYSCALE)
    return np.where(image<128,255,0).astype(np.uint8)


class PixelTopologyTests(unittest.TestCase):
    def _fixture(self,path):
        root=Path(path)
        folder=fixture(root)
        triage.analyze(root,MANIFEST,cv2,np,write=True)
        wings.analyze(root,MANIFEST,cv2,np,write=True)
        return root,folder

    def test_open_v_arrow_stroke_has_connected_pixel_evidence(self):
        result=subject.connected_pixel_evidence(
            pixel_mask(synthetic()),[130.,80.],[15.,80.],1.,.7,cv2)
        self.assertEqual(result["review_state"],"CONNECTED_PIXEL_PATTERN_REVIEW")
        self.assertGreaterEqual(result["connected_left_wing_samples"],3)
        self.assertGreaterEqual(result["connected_right_wing_samples"],3)
        self.assertTrue(result["does_not_verify_arrow"])

    def test_lone_line_has_no_connected_bilateral_wings(self):
        result=subject.connected_pixel_evidence(
            pixel_mask(synthetic(with_wings=False)),
            [130.,80.],[15.,80.],1.,.7,cv2)
        self.assertEqual(result["review_state"],"BROKEN_PIXEL_CONNECTIVITY_REVIEW")

    def test_dense_text_like_solid_ink_fails_semantic_promotion(self):
        solid=np.ones((160,240),dtype=np.uint8)*255
        result=subject.connected_pixel_evidence(
            solid,[130.,80.],[15.,80.],1.,.7,cv2)
        self.assertEqual(result["review_state"],"DENSE_COMPONENT_AMBIGUOUS")
        self.assertTrue(result["does_not_verify_arrow"])

    def test_disconnected_wings_do_not_claim_connectivity(self):
        image=np.full((160,240,3),255,np.uint8)
        cv2.line(image,(15,80),(110,80),(0,0,0),2)
        cv2.line(image,(130,80),(112,67),(0,0,0),2)
        cv2.line(image,(130,80),(112,93),(0,0,0),2)
        ok,raw=cv2.imencode(".png",image)
        self.assertTrue(ok)
        result=subject.connected_pixel_evidence(
            pixel_mask(raw.tobytes()),[110.,80.],[15.,80.],1.,.7,cv2)
        self.assertNotEqual(result["review_state"],"CONNECTED_PIXEL_PATTERN_REVIEW")

    def test_image_border_is_censored_not_spurious_valid_arrow(self):
        out=subject.connected_pixel_evidence(
            np.ones((160,240),np.uint8)*255,
            [10.,10.],[0.,10.],1.,.7,cv2)
        self.assertTrue(out["boundary_censored"])
        self.assertTrue(out["does_not_verify_arrow"])

    def test_invalid_geometry_rejected(self):
        mask=np.zeros((160,240),np.uint8)
        for coords in (([float("nan"),80.],[15.,80.],1.,.7),
                       ([130.,80.],[15.,80.],3.,.7),
                       ([130.,80.],[15.,80.],1.,float("inf")),
                       ([130.,80.],[129.,80.],1.,.7)):
            with self.subTest(coords=coords):
                with self.assertRaises(subject.VisualGateError):
                    subject.connected_pixel_evidence(mask,*coords,cv2)

    def test_all_candidates_preserved_and_glm_candidate_ignored(self):
        with tempfile.TemporaryDirectory() as temp:
            root,folder=self._fixture(temp)
            model=folder/"visual_graph_proposal_B31.candidate.private.json"
            model.write_text("MODEL_GRAPH_MUST_NOT_AFFECT_OR_BE_READ",encoding="utf-8")
            prev=(folder/"b31_vtip_wing_continuity.private.json").read_bytes()
            result=subject.analyze(root,MANIFEST,cv2,np)
            self.assertEqual(result["tested_candidate_count"],2)
            self.assertEqual([v["source_candidate_index"] for v in
                              result["source_candidate_observations"]],[1,2])
            self.assertEqual(sum(result["review_counts"].values()),2)
            self.assertIsNone(result["independent_graph_gold"])
            self.assertFalse(result["arrow_direction_verified"])
            self.assertEqual(model.read_text(),"MODEL_GRAPH_MUST_NOT_AFFECT_OR_BE_READ")
            self.assertEqual((folder/"b31_vtip_wing_continuity.private.json").read_bytes(),prev)
            self.assertFalse((folder/subject.OUTPUT).exists())

    def test_private_write_one_time_and_readonly_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root,folder=self._fixture(temp)
            saved=subject.analyze(root,MANIFEST,cv2,np,write=True)
            path=folder/subject.OUTPUT
            self.assertEqual(json.loads(path.read_text("utf-8")),saved)
            audit=subject.audit_existing(root,MANIFEST)
            self.assertEqual(audit["tested_candidate_count"],2)
            with self.assertRaisesRegex(subject.VisualGateError,"ALREADY_EXISTS"):
                subject.analyze(root,MANIFEST,cv2,np,write=True)

    def test_forged_gold_or_tampered_source_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root,folder=self._fixture(temp)
            subject.analyze(root,MANIFEST,cv2,np,write=True)
            receipt=folder/subject.OUTPUT
            data=json.loads(receipt.read_text("utf-8"))
            data["arrow_direction_verified"]=True
            receipt.write_text(json.dumps(data),encoding="utf-8")
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.audit_existing(root,MANIFEST)
        with tempfile.TemporaryDirectory() as temp:
            root,folder=self._fixture(temp)
            png=folder/"b31_source_only_page126.private.png"
            png.write_bytes(png.read_bytes()+b"x")
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.analyze(root,MANIFEST,cv2,np)

    def test_missing_source_fails_without_side_effects(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with self.assertRaises(subject.VisualGateError):
                subject.analyze(root,MANIFEST,cv2,np,write=True)
            self.assertFalse((root/"semantic_gate").exists())


if __name__=="__main__":
    unittest.main()
