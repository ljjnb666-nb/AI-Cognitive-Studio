"""Synthetic source-only B31 clutter ordering, SHA and no-gold invariants."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b31_vtip_clutter_triage as subject

PDF_SHA = "b"*64
MANIFEST = {"sources":[
    {"id":"B15","size":10,"sha256":"a"*64,"total_physical_pages":438},
    {"id":"B31","size":30,"sha256":PDF_SHA,"total_physical_pages":504},
]}


def image_bytes():
    img=np.full((160,240,3),255,np.uint8)
    # Distinct non-overlapping horizontal line hypotheses.
    cv2.line(img,(12,100),(125,100),(0,0,0),2)
    cv2.line(img,(125,100),(105,86),(0,0,0),2)
    cv2.line(img,(125,100),(105,114),(0,0,0),2)
    cv2.line(img,(12,40),(125,40),(0,0,0),2)
    # Dense glyph-like clutter near the second endpoint only.
    for y in range(17,63,7):
        for x in range(100,154,7):
            cv2.rectangle(img,(x,y),(x+4,y+4),(0,0,0),-1)
    ok,arr=cv2.imencode(".png",img)
    assert ok
    return arr.tobytes()


def fixture(root, *, change_vtip=None):
    folder=root/"semantic_gate"
    folder.mkdir()
    png=image_bytes()
    png_sha=hashlib.sha256(png).hexdigest()
    (folder/"b31_source_only_page126.private.png").write_bytes(png)
    (folder/"b31_source_only_page126.private.json").write_text(
        json.dumps({
            "schema_version":1,"book_id":"B31","physical_page":126,
            "source_document_sha256":PDF_SHA,"private_png_sha256":png_sha,
            "render_width":240,"render_height":160,
            "provenance":"PDF_NATIVE_INDEPENDENT_OF_GLM_PREDICTION",
            "human_verified":False,"certified_graph_f1":None,
        }),encoding="utf-8")
    cv_data={
        "schema_version":1,"book_id":"B31","physical_page":126,
        "source_document_sha256":PDF_SHA,"source_page_png_sha256":png_sha,
        "evidence":"SOURCE_OPENCV_UNSUPERVISED_NOT_GRAPH_GOLD",
        "candidate_count_is_not_graph_count":True,
        "node_count_verified":False,"arrow_direction_verified":False,
        "independent_graph_gold":None,"certified_graph_f1":None,
        "hough_line_candidates":[[12,100,125,100],[12,40,125,40]],
        "triangle_vertices":[],
        "line_candidates_truncated":False,"triangles_truncated":False,
    }
    (folder/"b31_opencv_source_candidates.private.json").write_text(
        json.dumps(cv_data),encoding="utf-8")
    review=b"synthetic private source overlay, never publish"
    (folder/"b31_multiscale_vtip_review.private.png").write_bytes(review)
    cand=[
        {"endpoint":[125.0,100.0],"wing_support":[4,4],"scale":1.0,
         "slope":0.7,"support_min":4,"shaft_index":1,"end_index":1},
        {"endpoint":[125.0,40.0],"wing_support":[4,4],"scale":1.0,
         "slope":0.7,"support_min":4,"shaft_index":0,"end_index":1},
    ]
    vtip={
        "schema_version":1,"book_id":"B31","physical_page":126,
        "evidence":"B31_ORIGINAL_RASTER_V_WING_MULTISCALE_UNVERIFIED",
        "original_shaft_hypotheses":2,
        "candidate_endpoint_count_total":2,"endpoint_candidates":cand,
        "endpoint_candidates_truncated":False,
        "source_document_sha256":PDF_SHA,
        "source_page_png_sha256":png_sha,
        "private_review_png_sha256":hashlib.sha256(review).hexdigest(),
        "arrow_direction_verified":False,"node_count_verified":False,
        "independent_graph_gold":None,"certified_graph_f1":None,"provider_calls":0,
    }
    vtip.update(change_vtip or {})
    (folder/"b31_multiscale_vtip_source.private.json").write_text(
        json.dumps(vtip),encoding="utf-8")
    return folder


class B31TriageTests(unittest.TestCase):
    def test_dense_glyph_background_has_more_ink_than_open_arrow(self):
        png=image_bytes()
        gray=cv2.imdecode(np.frombuffer(png,np.uint8),cv2.IMREAD_GRAYSCALE)
        mask=np.where(gray<128,255,0).astype(np.uint8)
        left=subject.classify_roi(mask,125,100,cv2)
        dense=subject.classify_roi(mask,125,40,cv2)
        self.assertLess(left["local_ink_percent"],dense["local_ink_percent"])
        self.assertEqual(left["review_bucket"],"LOW_CLUTTER_REVIEW")
        self.assertEqual(dense["review_bucket"],"DENSE_INK_REVIEW")

    def test_all_candidates_retained_in_source_order_and_no_gold(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            fixture(root)
            result=subject.analyze(root,MANIFEST,cv2,np)
            self.assertEqual(result["source_tip_count_total"],2)
            self.assertEqual(result["reviewed_tip_count"],2)
            self.assertEqual([x["source_candidate_index"]
                              for x in result["triage_entries"]],[1,2])
            self.assertEqual(sum(result["review_bucket_counts"].values()),2)
            self.assertFalse(result["arrow_direction_verified"])
            self.assertFalse(result["classification_semantic_accuracy_verified"])
            self.assertIsNone(result["certified_graph_f1"])

    def test_contact_sheet_exclusive_and_audit_idempotent(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            folder=fixture(root)
            raw=(folder/"b31_source_only_page126.private.png").read_bytes()
            private=folder/"visual_graph_proposal_B31.candidate.private.json"
            private.write_text("DO NOT USE MODEL ANSWER",encoding="utf-8")
            result=subject.analyze(root,MANIFEST,cv2,np,write=True)
            self.assertTrue((folder/subject.SHEET).read_bytes().startswith(b"\x89PNG"))
            self.assertEqual(subject.audit_existing(root,MANIFEST)["reviewed_tip_count"],2)
            self.assertEqual((folder/"b31_source_only_page126.private.png").read_bytes(),raw)
            self.assertEqual(private.read_text(),"DO NOT USE MODEL ANSWER")
            self.assertEqual(result["provider_calls"],0)
            with self.assertRaisesRegex(subject.VisualGateError,"ALREADY_EXISTS"):
                subject.analyze(root,MANIFEST,cv2,np,write=True)

    def test_candidate_endpoint_not_matching_source_shaft_rejected(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            folder=fixture(root)
            p=folder/"b31_multiscale_vtip_source.private.json"
            obj=json.loads(p.read_text())
            obj["endpoint_candidates"][0]["endpoint"]=[55.0,55.0]
            p.write_text(json.dumps(obj),encoding="utf-8")
            with self.assertRaisesRegex(subject.VisualGateError,"NOT_SOURCE_SHAFT_ENDPOINT"):
                subject.analyze(root,MANIFEST,cv2,np)

    def test_duplicate_source_indices_and_forged_support_rejected(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            fixture(root)
            with self.assertRaisesRegex(subject.VisualGateError,"CANDIDATE_SCHEMA_INVALID"):
                subject.check_candidates({
                    "endpoint_candidates":[
                        {"shaft_index":0,"end_index":1,"endpoint":[125.,100.],
                         "wing_support":[9,9],"support_min":9,
                         "scale":1.0,"slope":0.7},
                    ],
                    "candidate_endpoint_count_total":1,
                    "endpoint_candidates_truncated":False,
                    "original_shaft_hypotheses":1,
                },[{"endpoints":[[12.,100.],[125.,100.]]}],240,160)

    def test_forged_prior_gold_and_source_digest_rejected(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            fixture(root,change_vtip={"arrow_direction_verified":True})
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.analyze(root,MANIFEST,cv2,np)
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            folder=fixture(root)
            png=folder/"b31_source_only_page126.private.png"
            png.write_bytes(png.read_bytes()+b"tamper")
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.analyze(root,MANIFEST,cv2,np)

    def test_contact_sheet_tamper_rejected(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            folder=fixture(root)
            subject.analyze(root,MANIFEST,cv2,np,write=True)
            f=folder/subject.SHEET
            f.write_bytes(f.read_bytes()+b"tamper")
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.audit_existing(root,MANIFEST)

    def test_partial_previous_write_fails_closed(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            folder=fixture(root)
            (folder/subject.SHEET).write_bytes(b"partial")
            with self.assertRaises(subject.VisualGateError):
                subject.audit_existing(root,MANIFEST)
            with self.assertRaisesRegex(subject.VisualGateError,"ALREADY_EXISTS"):
                subject.analyze(root,MANIFEST,cv2,np,write=True)

    def test_missing_root_never_mutates_folder(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            with self.assertRaises(subject.VisualGateError):
                subject.analyze(root,MANIFEST,cv2,np,write=True)
            self.assertFalse((root/"semantic_gate").exists())

    def test_ink_measurement_is_review_priority_not_arrow_truth(self):
        blank=np.zeros((80,80),np.uint8)
        result=subject.classify_roi(blank,40,40,cv2)
        self.assertEqual(result["review_bucket"],"LOW_CLUTTER_REVIEW")
        self.assertNotIn("arrow_correct",result)
        self.assertNotIn("graph_f1",result)


if __name__=="__main__":
    unittest.main()
