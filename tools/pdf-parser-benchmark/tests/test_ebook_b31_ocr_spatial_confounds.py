"""Source-only OCR text-box spatial confound test coverage: NO GLM data."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import cv2
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b31_ocr_spatial_confounds as subject
from test_ebook_b31_vtip_clutter_triage import fixture,MANIFEST


class SpatialB31Tests(unittest.TestCase):
    def test_rotated_convex_quad_inside_is_zero_distance(self):
        quad=subject.validated_quad([[30,10],[40,20],[30,30],[20,20]])
        self.assertEqual(subject.quad_distance((30.,20.),quad),0.0)
        self.assertGreater(subject.quad_distance((6.,6.),quad),8)

    def test_near_and_outside_are_distinct(self):
        quad=subject.validated_quad([[15,15],[55,15],[55,45],[15,45]])
        self.assertEqual(subject.proximity([20,20],[quad])["text_box_state"],
                         "OCR_BOX_INTERIOR")
        self.assertEqual(subject.proximity([60,30],[quad])["text_box_state"],
                         "OCR_BOX_NEAR")
        self.assertEqual(subject.proximity([90,90],[quad])["text_box_state"],
                         "OCR_BOX_OUTSIDE")
        self.assertIsNone(subject.proximity([20,20],[])["nearest_ocr_line_index"])

    def test_polygon_corner_distance_not_axis_aligned_shortcut(self):
        quad=subject.validated_quad([[30,10],[40,20],[30,30],[20,20]])
        self.assertEqual(subject.proximity((39,11),[quad])["text_box_state"],
                         "OCR_BOX_NEAR")
        self.assertGreater(subject.quad_distance((39,11),quad),0)

    def test_invalid_degenerate_or_self_crossing_polygon_rejected(self):
        for pts in (
            [[0,0],[10,10],[0,10],[10,0]],
            [[0,0],[1,1],[2,2],[3,3]],
            [[0,0],[0,0],[10,10],[0,10]],
            [[0,0],[20,0],[10,2],[0,20]],
            [[0,0],[float("nan"),0],[10,10],[0,10]],
        ):
            with self.subTest(pts=pts):
                with self.assertRaises(subject.VisualGateError):
                    subject.validated_quad(pts)

    def test_no_candidate_drop_and_cross_tabs_consistent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder=fixture(root)
            sample=self._inputs(folder)
            with mock.patch.object(subject,"load_inputs",return_value=sample):
                report,_=subject.build_report(root,MANIFEST)
            self.assertEqual(report["candidate_count"],103)
            self.assertEqual(report["ocr_recognized_line_count"],50)
            self.assertEqual(sum(report["spatial_counts"].values()),103)
            self.assertEqual(len(report["candidate_reviews"]),103)
            self.assertEqual([p["original_candidate_index"] for p in report[
                "candidate_reviews"]],list(range(1,104)))
            self.assertEqual(sum(sum(row.values()) for row in
                                 report["wing_state_cross_tab"].values()),103)
            self.assertEqual(sum(sum(row.values()) for row in
                                 report["topology_state_cross_tab"].values()),103)
            self.assertFalse(report["arrow_direction_verified"])
            self.assertIsNone(report["certified_graph_f1"])

    def test_private_ocr_overlay_and_receipt_are_readonly_auditable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            folder=fixture(root)
            inputs=self._inputs(folder)
            p=folder/"visual_graph_proposal_B31.candidate.private.json"
            p.write_text("never consume this model proposal",encoding="utf-8")
            source=(folder/"b31_source_only_page126.private.png").read_bytes()
            with mock.patch.object(subject,"load_inputs",return_value=inputs):
                results=subject.run(root,MANIFEST,cv2,np,write=True)
                self.assertEqual(subject.audit_existing(root,MANIFEST),results)
                self.assertTrue((folder/subject.REVIEW).read_bytes().startswith(b"\x89PNG"))
                self.assertEqual((folder/"b31_source_only_page126.private.png").read_bytes(),source)
                self.assertEqual(p.read_text(),"never consume this model proposal")
                with self.assertRaisesRegex(subject.VisualGateError,"ALREADY_EXISTS"):
                    subject.run(root,MANIFEST,cv2,np,write=True)

    def test_tampering_report_or_overlay_breaks_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=fixture(root)
            inputs=self._inputs(folder)
            with mock.patch.object(subject,"load_inputs",return_value=inputs):
                subject.run(root,MANIFEST,cv2,np,write=True)
                png=folder/subject.REVIEW
                png.write_bytes(png.read_bytes()+b"corrupted")
                with self.assertRaisesRegex(subject.VisualGateError,"MISMATCH"):
                    subject.audit_existing(root,MANIFEST)

    def test_forged_gold_fails_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=fixture(root)
            inputs=self._inputs(folder)
            with mock.patch.object(subject,"load_inputs",return_value=inputs):
                subject.run(root,MANIFEST,cv2,np,write=True)
                path=folder/subject.OUT
                data=json.loads(path.read_text("utf-8"))
                data["certified_graph_f1"]=1.
                path.write_text(json.dumps(data),encoding="utf-8")
                with self.assertRaisesRegex(subject.VisualGateError,"MISMATCH"):
                    subject.audit_existing(root,MANIFEST)

    def test_incomplete_output_rejected_without_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder=fixture(root)
            inputs=self._inputs(folder)
            (folder/subject.REVIEW).write_bytes(b"partial")
            with mock.patch.object(subject,"load_inputs",return_value=inputs):
                with self.assertRaises(subject.VisualGateError):
                    subject.audit_existing(root,MANIFEST)
                with self.assertRaisesRegex(subject.VisualGateError,"ALREADY_EXISTS"):
                    subject.run(root,MANIFEST,cv2,np,write=True)

    def test_real_upstream_fixtures_have_only_two_candidates_and_fail_closed(self):
        # A synthetic 2-tip fixture must not masquerade as pinned B31 103 tips.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            fixture(root)
            with self.assertRaises(subject.VisualGateError):
                subject.load_inputs(root,MANIFEST)

    def _inputs(self,folder):
        meta=json.loads((folder/"b31_source_only_page126.private.json").read_text())
        meta["private_png_sha256"]=hashlib.sha256(
            (folder/"b31_source_only_page126.private.png").read_bytes()).hexdigest()
        source=[];wings=[];topology=[]
        for i in range(103):
            x=float(20+i%15*12)
            y=float(30+i//15*15)
            source.append({"endpoint":[x,y]})
            wing=(subject.WING_STATES[0] if i<3 else
                  subject.WING_STATES[1] if i<87 else subject.WING_STATES[2])
            topo=subject.TOPO_STATES[0] if i<32 else subject.TOPO_STATES[2]
            wings.append({"review_state":wing})
            topology.append({"review_state":topo})
        quads=[subject.validated_quad([[10,18],[54,18],[54,38],[10,38]])
               for _ in range(50)]
        ocr={"private_rows_sha256":"e"*64}
        return (meta,folder,ocr,source,
                {"candidate_reviews":wings},
                {"source_candidate_observations":topology},quads)


if __name__=="__main__":
    unittest.main()
