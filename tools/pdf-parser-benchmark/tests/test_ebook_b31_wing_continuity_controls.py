"""B31 negative control wings: synthetic pixels, private immutability and gold guard."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b31_wing_continuity_controls as subject
import ebook_b31_vtip_clutter_triage as triage
from test_ebook_b31_vtip_clutter_triage import fixture, MANIFEST
from test_ebook_b31_multiscale_vtip_review import synthetic


def threshold(png):
    gray=cv2.imdecode(np.frombuffer(png,np.uint8),cv2.IMREAD_GRAYSCALE)
    return gray<128


class WingControlsTests(unittest.TestCase):
    def test_two_real_synthetic_wings_have_continuity_and_clear_controls(self):
        evidence=subject.pixel_controls(
            threshold(synthetic()),[130.0,80.0],[15.0,80.0],1.0,0.7)
        self.assertEqual(evidence["review_state"],"PIXEL_CONTRAST_REVIEW")
        self.assertGreaterEqual(min(evidence["wing_longest_consecutive"]),3)
        self.assertLessEqual(max(evidence["beyond_tip_negative_controls"]),1)
        self.assertTrue(evidence["does_not_certify_arrow"])

    def test_lone_horizontal_shaft_does_not_forge_wings(self):
        evidence=subject.pixel_controls(
            threshold(synthetic(with_wings=False)),
            [130.0,80.0],[15.0,80.0],1.0,0.7)
        self.assertEqual(evidence["review_state"],"WING_CONTINUITY_WEAK")

    def test_solid_dark_background_is_not_an_arrow(self):
        mask=np.ones((160,240),dtype=bool)
        evidence=subject.pixel_controls(mask,[130.,80.],[15.,80.],1.0,0.7)
        self.assertEqual(evidence["review_state"],"BACKGROUND_INK_AMBIGUOUS")
        self.assertEqual(evidence["outer_flank_negative_controls"],[5,5])

    def test_sparse_isolated_noise_fails_continuity(self):
        mask=np.zeros((160,240),dtype=bool)
        for k in (6,10,14):
            for side in (-1,1):
                x=130-k
                y=80+side*round(.7*k)
                mask[y,x]=True
        evidence=subject.pixel_controls(mask,[130.,80.],[15.,80.],1.0,0.7)
        self.assertEqual(evidence["review_state"],"WING_CONTINUITY_WEAK")

    def test_unbounded_or_invalid_controls_fail_closed(self):
        m=np.zeros((160,240),dtype=bool)
        for args in (
            ([130.,80.],[129.,80.],1.,.7),
            ([float("nan"),80.],[15.,80.],1.,.7),
            ([130.,80.],[15.,80.],3.,.7),
            ([130.,80.],[15.,80.],1.,float("inf")),
        ):
            with self.subTest(args=args):
                with self.assertRaises(subject.VisualGateError):
                    subject.pixel_controls(m,*args)

    def _ready(self,root):
        folder=fixture(root)
        triage.analyze(root,MANIFEST,cv2,np,write=True)
        return folder

    def test_all_original_tips_retained_without_model_predictions(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            folder=self._ready(root)
            model=folder/"visual_graph_proposal_B31.candidate.private.json"
            model.write_text("SECRET GLM GRAPH SHOULD NEVER BE READ",encoding="utf-8")
            previous=(folder/"b31_vtip_clutter_triage.private.json").read_bytes()
            report=subject.analyze(root,MANIFEST,cv2,np)
            self.assertEqual(report["original_candidate_count"],2)
            self.assertEqual(report["tested_candidate_count"],2)
            self.assertEqual(sum(report["state_counts"].values()),2)
            self.assertEqual([x["candidate_index"] for x in report["candidate_reviews"]],[1,2])
            self.assertTrue(report["all_candidates_preserved"])
            self.assertFalse(report["arrow_direction_verified"])
            self.assertIsNone(report["certified_graph_f1"])
            self.assertEqual(model.read_text(),"SECRET GLM GRAPH SHOULD NEVER BE READ")
            self.assertEqual((folder/"b31_vtip_clutter_triage.private.json").read_bytes(),previous)
            self.assertFalse((folder/subject.OUTPUT).exists())

    def test_exclusive_private_write_and_readonly_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            folder=self._ready(root)
            result=subject.analyze(root,MANIFEST,cv2,np,write=True)
            disk=folder/subject.OUTPUT
            self.assertEqual(json.loads(disk.read_text("utf-8")),result)
            self.assertEqual(subject.audit_existing(root,MANIFEST)["tested_candidate_count"],2)
            with self.assertRaisesRegex(subject.VisualGateError,"ALREADY_EXISTS"):
                subject.analyze(root,MANIFEST,cv2,np,write=True)

    def test_forged_candidate_identity_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            folder=self._ready(root)
            path=folder/"b31_vtip_clutter_triage.private.json"
            obj=json.loads(path.read_text("utf-8"))
            obj["triage_entries"][0]["source_candidate_index"]=2
            path.write_text(json.dumps(obj),encoding="utf-8")
            with self.assertRaisesRegex(subject.VisualGateError,"CANDIDATE_IDENTITY_INVALID"):
                subject.analyze(root,MANIFEST,cv2,np)

    def test_false_gold_and_corrupted_source_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            folder=self._ready(root)
            metadata=folder/"b31_source_only_page126.private.json"
            obj=json.loads(metadata.read_text())
            obj["human_verified"]=True
            metadata.write_text(json.dumps(obj),encoding="utf-8")
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.analyze(root,MANIFEST,cv2,np)

    def test_existing_receipt_tamper_and_missing_source_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            folder=self._ready(root)
            subject.analyze(root,MANIFEST,cv2,np,write=True)
            out=folder/subject.OUTPUT
            obj=json.loads(out.read_text("utf-8"))
            obj["independent_graph_gold"]={"f1":1}
            out.write_text(json.dumps(obj),encoding="utf-8")
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.audit_existing(root,MANIFEST)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            with self.assertRaises(subject.VisualGateError):
                subject.analyze(root,MANIFEST,cv2,np,write=True)
            self.assertFalse((root/"semantic_gate").exists())


if __name__=="__main__":
    unittest.main()
