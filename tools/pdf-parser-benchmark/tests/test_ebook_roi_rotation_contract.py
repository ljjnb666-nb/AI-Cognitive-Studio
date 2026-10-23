"""Synthetic-only rotation anchor controls; NEVER real B15/B31 accuracy."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"scripts"))
from ebook_private_roi_alignment import Rejected
from ebook_roi_rotation_contract import (
    AUTHORITY, FRAME_DISPLAY, FRAME_UNROTATED,
    calibrated_match, main, rotate_box, rotate_point,
)

SHA = "b" * 64
BOX = [.1, .2, .3, .4]
ANCHORS = [[.1, .1], [.7, .2], [.3, .9]]
REFERENCE = {
    "authority": "L2_AI_VISUAL_PROVISIONAL_NOT_HUMAN_GROUND_TRUTH",
    "regions": [{
        "book_id": "B15", "physical_page": 109,
        "source_document_sha256": SHA, "evidence": "L2_AI_VISUAL_PROVISIONAL",
        "roi_xyxy_normalized": list(rotate_box(BOX, 270)),
    }],
}
CANDIDATE = {
    "schema_version": 1, "book_id": "B15", "physical_page": 109,
    "source_document_sha256": SHA, "engine": "Docling",
    "picture_boxes_normalized": [BOX],
}
CALIBRATION = {
    "schema_version": 1, "authority": AUTHORITY,
    "book_id": "B15", "physical_page": 109,
    "source_document_sha256": SHA, "source_pdf_rotation_degrees": 270,
    "candidate_frame": FRAME_UNROTATED, "reference_frame": FRAME_DISPLAY,
    "anchor_pairs": [{
        "candidate_point": point,
        "display_point": list(rotate_point(point, 270)),
    } for point in ANCHORS],
}


class RotationContract(unittest.TestCase):
    def test_all_four_page_rotation_boxes(self):
        self.assertEqual(rotate_box(BOX, 0), (.1, .2, .3, .4))
        self.assertEqual(rotate_box(BOX, 90), (.6, .1, .8, .3))
        self.assertEqual(rotate_box(BOX, 180), (.7, .6, .9, .8))
        self.assertEqual(rotate_box(BOX, 270), (.2, .7, .4, .9))

    def test_four_rotations_point_roundtrip(self):
        point = (.12, .31)
        for d in (0, 90, 180, 270):
            after = rotate_point(point, d)
            before = rotate_point(after, (360-d)%360)
            self.assertAlmostEqual(before[0], point[0], 10)
            self.assertAlmostEqual(before[1], point[1], 10)

    def test_b15_provisional_matched_after_calibration(self):
        result = calibrated_match(REFERENCE, CANDIDATE, CALIBRATION)
        self.assertEqual(result["one_to_one_region_matches"], 1)
        self.assertEqual(result["coordinate_transform_status"], "PRIVATE_L2_FRAME_CALIBRATION_PROVISIONAL")
        self.assertEqual(result["source_pdf_rotation_degrees"], 270)
        self.assertEqual(result["calibration_anchor_count"], 3)
        self.assertFalse(result["graph_verified"])
        self.assertIsNone(result["certified_graph_f1"])
        self.assertIsNone(result["certified_region_recall"])
        self.assertEqual(result["graph_semantics"], "UNVERIFIED")
        self.assertNotIn(SHA, json.dumps(result))
        self.assertNotIn("anchor_pairs", result)
        self.assertNotIn("picture_boxes_normalized", result)

    def test_no_fake_match_from_uncalibrated_rotation(self):
        invalid = copy.deepcopy(CALIBRATION)
        invalid["anchor_pairs"][0]["display_point"] = [.7, .7]
        with self.assertRaisesRegex(Rejected, "FRAME_ANCHOR_RESIDUAL_TOO_LARGE"):
            calibrated_match(REFERENCE, CANDIDATE, invalid)

    def test_display_frame_keeps_boxes_unrotated(self):
        ref = copy.deepcopy(REFERENCE)
        cand = copy.deepcopy(CANDIDATE)
        cand["picture_boxes_normalized"] = [list(rotate_box(BOX, 270))]
        cal = copy.deepcopy(CALIBRATION)
        cal["candidate_frame"] = FRAME_DISPLAY
        for pair in cal["anchor_pairs"]:
            pair["candidate_point"] = list(pair["display_point"])
        self.assertEqual(calibrated_match(ref, cand, cal)["one_to_one_region_matches"], 1)

    def test_cross_document_sha_fails_closed(self):
        cal = copy.deepcopy(CALIBRATION)
        cal["source_document_sha256"] = "c"*64
        with self.assertRaisesRegex(Rejected, "FRAME_PROVENANCE_MISMATCH"):
            calibrated_match(REFERENCE, CANDIDATE, cal)

    def test_cross_book_or_page_fails_closed(self):
        for key, value in (("book_id", "B31"), ("physical_page", 110)):
            cal = copy.deepcopy(CALIBRATION)
            cal[key] = value
            with self.assertRaisesRegex(Rejected, "FRAME_PROVENANCE_MISMATCH"):
                calibrated_match(REFERENCE, CANDIDATE, cal)

    def test_invalid_rotation_rejected(self):
        for d in (True, 45, 360, "270", -90):
            cal = copy.deepcopy(CALIBRATION)
            cal["source_pdf_rotation_degrees"] = d
            with self.assertRaisesRegex(Rejected, "INVALID_PDF_PAGE_ROTATION"):
                calibrated_match(REFERENCE, CANDIDATE, cal)

    def test_wrong_reference_frame_not_allowed(self):
        cal = copy.deepcopy(CALIBRATION)
        cal["reference_frame"] = "PDF_UNROTATED_TOPLEFT"
        with self.assertRaisesRegex(Rejected, "FRAME_COORDINATE_CONVENTION_INVALID"):
            calibrated_match(REFERENCE, CANDIDATE, cal)

    def test_three_landmarks_required(self):
        cal = copy.deepcopy(CALIBRATION)
        cal["anchor_pairs"] = cal["anchor_pairs"][:2]
        with self.assertRaisesRegex(Rejected, "FRAME_ANCHOR_COUNT_INVALID"):
            calibrated_match(REFERENCE, CANDIDATE, cal)

    def test_collinear_landmarks_fail(self):
        cal = copy.deepcopy(CALIBRATION)
        cal["anchor_pairs"] = [{
            "candidate_point": p,
            "display_point": list(rotate_point(p, 270)),
        } for p in ([.1, .1], [.2, .2], [.3, .3])]
        with self.assertRaisesRegex(Rejected, "FRAME_ANCHOR_DEGENERATE"):
            calibrated_match(REFERENCE, CANDIDATE, cal)

    def test_duplicate_landmarks_fail(self):
        cal = copy.deepcopy(CALIBRATION)
        cal["anchor_pairs"][1] = copy.deepcopy(cal["anchor_pairs"][0])
        with self.assertRaisesRegex(Rejected, "FRAME_ANCHOR_DUPLICATED"):
            calibrated_match(REFERENCE, CANDIDATE, cal)

    def test_bool_nan_and_invalid_points_fail(self):
        for invalid in ([True, .1], [float("nan"), .1], [1.1, .1], ["0.5", .5]):
            cal = copy.deepcopy(CALIBRATION)
            cal["anchor_pairs"][1]["candidate_point"] = invalid
            with self.assertRaisesRegex(Rejected, "FRAME_ANCHOR_INVALID"):
                calibrated_match(REFERENCE, CANDIDATE, cal)

    def test_bad_schema_and_forbidden_gold_claim_fail(self):
        for name, val in (("schema_version", 2), ("authority", "HUMAN_GOLD")):
            cal = copy.deepcopy(CALIBRATION)
            cal[name] = val
            with self.assertRaisesRegex(Rejected, "FRAME_CALIBRATION_SCHEMA_INVALID"):
                calibrated_match(REFERENCE, CANDIDATE, cal)
        cal = copy.deepcopy(CALIBRATION)
        cal["humanVerified"] = True
        with self.assertRaisesRegex(Rejected, "UNAUTHORIZED_VERIFICATION_CLAIM"):
            calibrated_match(REFERENCE, CANDIDATE, cal)

    def test_private_paths_no_coordinates_on_stdout_or_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, value in (("reference.json", REFERENCE), ("candidate.json", CANDIDATE), ("calibration.json", CALIBRATION)):
                (root/name).write_text(json.dumps(value), encoding="utf-8")
            out = root/"report.json"
            self.assertEqual(main([
                "--private-root", folder,
                "--reference", str(root/"reference.json"),
                "--candidate", str(root/"candidate.json"),
                "--calibration", str(root/"calibration.json"),
                "--output", str(out),
            ]), 0)
            report = out.read_text(encoding="utf-8")
            self.assertNotIn(SHA, report)
            self.assertNotIn("candidate_point", report)
            self.assertNotIn("roi_xyxy_normalized", report)

    def test_output_outside_private_root_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, value in (("reference.json", REFERENCE), ("candidate.json", CANDIDATE), ("calibration.json", CALIBRATION)):
                (root/name).write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(Rejected, "PRIVATE_REPORT_PATH_REQUIRED"):
                main([
                    "--private-root", folder,
                    "--reference", str(root/"reference.json"),
                    "--candidate", str(root/"candidate.json"),
                    "--calibration", str(root/"calibration.json"),
                    "--output", str(root.parent/"leak.json"),
                ])


if __name__ == "__main__":
    unittest.main()
