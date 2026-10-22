"""Synthetic-only Docling normalized ROI geometry and privacy checks."""
import copy
from pathlib import Path
from types import SimpleNamespace as Obj
import json
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"scripts"))
from ebook_private_roi_alignment import Rejected, docling_bbox_normalized, docling_picture_boxes, geometry_gate, match, main

SHA = "a"*64
REF = {"authority":"L2_AI_VISUAL_PROVISIONAL_NOT_HUMAN_GROUND_TRUTH", "regions":[
    {"book_id":"B15","physical_page":109,"source_document_sha256":SHA,"evidence":"L2_AI_VISUAL_PROVISIONAL","roi_xyxy_normalized":[.2,.2,.4,.4]},
    {"book_id":"B15","physical_page":109,"source_document_sha256":SHA,"evidence":"L2_AI_VISUAL_PROVISIONAL","roi_xyxy_normalized":[.5,.5,.8,.8]}]}
CAND = {"schema_version":1,"book_id":"B15","physical_page":109,"source_document_sha256":SHA,
        "engine":"Docling","picture_boxes_normalized":[[.21,.22,.41,.41],[.51,.51,.79,.79]]}

class Geometry(unittest.TestCase):
    def test_top_left(self):
        b = Obj(l=10,t=20,r=50,b=60,coord_origin="TOPLEFT")
        self.assertEqual(docling_bbox_normalized(b,Obj(width=100,height=100)),(.1,.2,.5,.6))
    def test_bottom_left(self):
        b = Obj(l=10,t=80,r=50,b=40,coord_origin="BOTTOMLEFT")
        self.assertEqual(docling_bbox_normalized(b,Obj(width=100,height=100)),(.1,.2,.5,.6))
    def test_unknown_origin(self):
        b=Obj(l=0,t=0,r=10,b=10,coord_origin="OTHER")
        with self.assertRaisesRegex(Rejected,"UNKNOWN_COORDINATE_ORIGIN"):
            docling_bbox_normalized(b,Obj(width=100,height=100))
    def test_zero_page_size(self):
        b=Obj(l=0,t=0,r=10,b=10,coord_origin="TOPLEFT")
        with self.assertRaisesRegex(Rejected,"INVALID_PAGE_SIZE"):
            docling_bbox_normalized(b,Obj(width=0,height=100))
    def test_nan_box(self):
        b=Obj(l=0,t=0,r=float("nan"),b=10,coord_origin="TOPLEFT")
        with self.assertRaisesRegex(Rejected,"INVALID_COORDINATE"):
            docling_bbox_normalized(b,Obj(width=100,height=100))
    def test_outside_box(self):
        b=Obj(l=0,t=0,r=101,b=10,coord_origin="TOPLEFT")
        with self.assertRaisesRegex(Rejected,"BBOX_OUTSIDE_NORMALIZED_PAGE"):
            docling_bbox_normalized(b,Obj(width=100,height=100))
    def test_single_page_provenance(self):
        pic=Obj(prov=[Obj(page_no=1,bbox=Obj(l=20,t=20,r=40,b=40,coord_origin="TOPLEFT"))])
        doc=Obj(pages={1:Obj(size=Obj(width=100,height=100))},pictures=[pic])
        self.assertEqual(docling_picture_boxes(doc),[(.2,.2,.4,.4)])
    def test_wrong_local_page(self):
        doc=Obj(pages={1:Obj(size=Obj(width=100,height=100))},
                pictures=[Obj(prov=[Obj(page_no=126,bbox=None)])])
        with self.assertRaisesRegex(Rejected,"DOCLING_WRONG_LOCAL_PAGE_NUMBER"):
            docling_picture_boxes(doc)
    def test_b15_valid_boxes_no_reference(self):
        self.assertEqual(geometry_gate("B15",2,[(.1,.1,.3,.3),(.4,.4,.8,.8)],270,False),"PRIVATE_REFERENCE_UNAVAILABLE")
    def test_b15_rotation_blocks_spatial_claim(self):
        self.assertEqual(geometry_gate("B15",2,[(.1,.1,.3,.3),(.4,.4,.8,.8)],270,True),"ROTATED_DISPLAY_TRANSFORM_UNVERIFIED")
    def test_b31_zero_boxes_fail_closed(self):
        with self.assertRaisesRegex(Rejected,"SCANNED_PICTURE_GEOMETRY_INCOMPLETE"):
            geometry_gate("B31",3,[],0,False)
    def test_b31_partial_boxes_fail_closed(self):
        with self.assertRaisesRegex(Rejected,"SCANNED_PICTURE_GEOMETRY_INCOMPLETE"):
            geometry_gate("B31",3,[(.1,.1,.3,.3)],0,False)
    def test_b31_good_boxes_may_align(self):
        self.assertEqual(geometry_gate("B31",1,[(.1,.1,.3,.3)],0,True),"PRIVATE_REFERENCE_READY_TO_MATCH")
    def test_invalid_rotation_rejected(self):
        with self.assertRaisesRegex(Rejected,"INVALID_PDF_PAGE_ROTATION"):
            geometry_gate("B31",1,[(.1,.1,.3,.3)],45,True)
    def test_invalid_bbox_rejected(self):
        with self.assertRaisesRegex(Rejected,"BBOX_OUTSIDE_NORMALIZED_PAGE"):
            geometry_gate("B31",1,[(.1,.1,1.2,.5)],0,True)
    def test_b16_no_picture_allowed(self):
        self.assertEqual(geometry_gate("B16",0,[],0,False),"PRIVATE_REFERENCE_UNAVAILABLE")
    def test_scanned_zero_picture_item_rejected(self):
        with self.assertRaisesRegex(Rejected,"SCANNED_PICTURE_GEOMETRY_INCOMPLETE"):
            geometry_gate("B15",0,[],270,False)
    def test_duplicate_boxes_cannot_meet_count(self):
        with self.assertRaisesRegex(Rejected,"SCANNED_PICTURE_GEOMETRY_INCOMPLETE"):
            geometry_gate("B31",2,[(.1,.1,.3,.3)],0,False)

    def test_two_hits_not_certified(self):
        result=match(REF,CAND)
        self.assertEqual(result["one_to_one_region_matches"],2)
        self.assertIsNone(result["certified_graph_f1"])
        self.assertFalse(result["human_verified"])
    def test_one_picture_cannot_hit_two(self):
        candidate=copy.deepcopy(CAND)
        candidate["picture_boxes_normalized"]=[[.2,.2,.8,.8]]
        self.assertLessEqual(match(REF,candidate)["one_to_one_region_matches"],1)
    def test_ambiguous_overlap_preserves_two_possible_matches(self):
        # R0 matches both boxes but R1 can only match B0.
        # Greedy highest-IoU would take R0->B0 and undercount as one.
        reference = {"authority": "L2_AI_VISUAL_PROVISIONAL_NOT_HUMAN_GROUND_TRUTH",
                     "regions": [
                         {"book_id": "B15", "physical_page": 109,
                          "source_document_sha256": SHA,
                          "evidence": "L2_AI_VISUAL_PROVISIONAL",
                          "roi_xyxy_normalized": [.1, .1, .7, .7]},
                         {"book_id": "B15", "physical_page": 109,
                          "source_document_sha256": SHA,
                          "evidence": "L2_AI_VISUAL_PROVISIONAL",
                          "roi_xyxy_normalized": [.1, .1, .4, .4]}]}
        candidate = copy.deepcopy(CAND)
        candidate["picture_boxes_normalized"] = [
            [.1, .1, .7, .7], [.4, .4, .7, .7]]
        result = match(reference, candidate)
        self.assertEqual(result["one_to_one_region_matches"], 2)
        self.assertEqual(result["unmatched_reference_regions"], 0)
        self.assertEqual(result["unmatched_picture_boxes"], 0)
        self.assertEqual(result["status"], "PROVISIONAL_SPATIAL_OVERLAP_ONLY")
        self.assertFalse(result["graph_verified"])
        self.assertIsNone(result["certified_graph_f1"])

    def test_duplicate_l2_reference_boxes_rejected(self):
        reference=copy.deepcopy(REF)
        reference["regions"].append(copy.deepcopy(reference["regions"][0]))
        with self.assertRaisesRegex(Rejected,"DUPLICATE_REFERENCE_REGION"):
            match(reference,CAND)

    def test_duplicate_candidate_boxes_rejected(self):
        candidate=copy.deepcopy(CAND)
        candidate["picture_boxes_normalized"].append(
            copy.deepcopy(candidate["picture_boxes_normalized"][0]))
        with self.assertRaisesRegex(Rejected,"DUPLICATE_PICTURE_BOX"):
            match(REF,candidate)

    def test_other_page_reference_not_counted_as_duplicate(self):
        reference=copy.deepcopy(REF)
        other=copy.deepcopy(reference["regions"][0])
        other["physical_page"]=110
        reference["regions"].append(other)
        self.assertEqual(match(reference,CAND)["one_to_one_region_matches"],2)

    def test_ambiguous_matching_is_deterministic(self):
        reference = copy.deepcopy(REF)
        candidate = copy.deepcopy(CAND)
        first = match(reference, candidate)
        for _ in range(3):
            self.assertEqual(match(reference, candidate), first)

    def test_empty_boxes_is_not_accuracy_zero(self):
        candidate=copy.deepcopy(CAND)
        candidate["picture_boxes_normalized"]=[]
        self.assertEqual(match(REF,candidate)["status"],"NO_SPATIAL_MATCH_UNVERIFIED")
    def test_sha_mismatch(self):
        candidate=copy.deepcopy(CAND)
        candidate["source_document_sha256"]="b"*64
        with self.assertRaisesRegex(Rejected,"SOURCE_DOCUMENT_SHA_MISMATCH"):
            match(REF,candidate)
    def test_unsupported_engine(self):
        candidate=copy.deepcopy(CAND)
        candidate["engine"]="unrelated"
        with self.assertRaisesRegex(Rejected,"UNSUPPORTED_ENGINE_CANDIDATE"):
            match(REF,candidate)
    def test_wrong_reference_page(self):
        candidate=copy.deepcopy(CAND)
        candidate["book_id"]="B31"
        with self.assertRaisesRegex(Rejected,"PRIVATE_REFERENCE_NOT_PRESENT_FOR_PAGE"):
            match(REF,candidate)
    def test_fake_verified_rejected(self):
        candidate=copy.deepcopy(CAND)
        candidate["humanVerified"]=True
        with self.assertRaisesRegex(Rejected,"UNAUTHORIZED_VERIFICATION_CLAIM"):
            match(REF,candidate)
    def test_report_private_and_text_free(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            (root/"ref.json").write_text(json.dumps(REF),encoding="utf-8")
            (root/"candidate.json").write_text(json.dumps(CAND),encoding="utf-8")
            target=root/"result.json"
            self.assertEqual(main(["--private-root",temp,"--reference",str(root/"ref.json"),
                "--candidate",str(root/"candidate.json"),"--output",str(target)]),0)
            saved=target.read_text()
            self.assertNotIn(SHA,saved)
            self.assertNotIn("0.21",saved)
    def test_output_outside_private_root_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            (root/"ref.json").write_text(json.dumps(REF),encoding="utf-8")
            (root/"candidate.json").write_text(json.dumps(CAND),encoding="utf-8")
            with self.assertRaisesRegex(Rejected,"PRIVATE_REPORT_PATH_REQUIRED"):
                main(["--private-root",temp,"--reference",str(root/"ref.json"),
                    "--candidate",str(root/"candidate.json"),
                    "--output",str(root.parent/"outside.json")])

if __name__ == "__main__":
    unittest.main()
