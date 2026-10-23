"""No-model B31 V-wing geometry, PNG source integrity and private overlay tests."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import ebook_b31_multiscale_vtip_review as subject
import cv2
import numpy as np

PDF_SHA="b"*64
MANIFEST={"sources":[
    {"id":"B15","size":9,"sha256":"a"*64,"total_physical_pages":438},
    {"id":"B31","size":52,"sha256":PDF_SHA,"total_physical_pages":504},
]}


def synthetic(with_wings=True, blank=False):
    image=np.full((160,240,3),255,np.uint8)
    if not blank:
        cv2.line(image,(15,80),(130,80),(0,0,0),2)
        if with_wings:
            cv2.line(image,(130,80),(104,64),(0,0,0),2)
            cv2.line(image,(130,80),(104,96),(0,0,0),2)
    valid,buf=cv2.imencode(".png",image)
    assert valid
    return buf.tobytes()


def setup(root,png,*,source_change=None,cv_change=None):
    folder=root/"semantic_gate"
    folder.mkdir()
    (folder/"b31_source_only_page126.private.png").write_bytes(png)
    meta={
        "schema_version":1,"book_id":"B31","physical_page":126,
        "source_document_sha256":PDF_SHA,
        "private_png_sha256":hashlib.sha256(png).hexdigest(),
        "provenance":"PDF_NATIVE_INDEPENDENT_OF_GLM_PREDICTION",
        "render_width":240,"render_height":160,
        "human_verified":False,"certified_graph_f1":None,
    }
    meta.update(source_change or {})
    (folder/"b31_source_only_page126.private.json").write_text(
        json.dumps(meta),encoding="utf-8")
    cv_data={
        "schema_version":1,"book_id":"B31","physical_page":126,
        "source_document_sha256":PDF_SHA,
        "source_page_png_sha256":hashlib.sha256(png).hexdigest(),
        "evidence":"SOURCE_OPENCV_UNSUPERVISED_NOT_GRAPH_GOLD",
        "candidate_count_is_not_graph_count":True,
        "arrow_direction_verified":False,"node_count_verified":False,
        "independent_graph_gold":None,"certified_graph_f1":None,
        "hough_line_candidates":[[15,80,130,80]],
        "triangle_vertices":[],
        "line_candidates_truncated":False,"triangles_truncated":False,
    }
    cv_data.update(cv_change or {})
    (folder/"b31_opencv_source_candidates.private.json").write_text(
        json.dumps(cv_data),encoding="utf-8")
    return folder


class VTipSourceOnly(unittest.TestCase):
    def test_open_v_shape_supports_unverified_candidate(self):
        png=synthetic()
        mask=np.array(cv2.imdecode(np.frombuffer(png,np.uint8),cv2.IMREAD_GRAYSCALE)<128)
        result=subject.wing_score(mask,[130.,80.],[15.,80.])
        self.assertIsNotNone(result)
        self.assertGreaterEqual(result["support_min"],3)

    def test_lone_horizontal_line_does_not_certify_v_tip(self):
        png=synthetic(with_wings=False)
        mask=np.array(cv2.imdecode(np.frombuffer(png,np.uint8),cv2.IMREAD_GRAYSCALE)<128)
        self.assertIsNone(subject.wing_score(mask,[130.,80.],[15.,80.]))

    def test_blank_pixels_do_not_inherit_cv_source_line_as_arrow(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            seed=setup(root,synthetic(blank=True))
            results=subject.run(root,MANIFEST,cv2,np)
            self.assertEqual(results["candidate_endpoint_count_total"],0)
            self.assertIsNone(results["independent_graph_gold"])
            self.assertFalse((seed/subject.OVERLAY_NAME).exists())
            self.assertFalse((seed/subject.REPORT_NAME).exists())

    def test_annotated_private_image_and_json_exclusive(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            private=setup(root,synthetic())
            raw=(private/"b31_source_only_page126.private.png").read_bytes()
            model=private/"visual_graph_proposal_B31.candidate.private.json"
            model.write_text("DO NOT READ PREDICTION",encoding="utf-8")
            results=subject.run(root,MANIFEST,cv2,np,write=True)
            self.assertGreater(results["candidate_endpoint_count_total"],0)
            report=private/subject.REPORT_NAME
            overlay=private/subject.OVERLAY_NAME
            self.assertTrue(report.is_file() and overlay.is_file())
            self.assertTrue(overlay.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertEqual(json.loads(report.read_text()),results)
            self.assertEqual((private/"b31_source_only_page126.private.png").read_bytes(),raw)
            self.assertEqual(model.read_text(),"DO NOT READ PREDICTION")
            self.assertFalse(results["arrow_direction_verified"])
            with self.assertRaisesRegex(subject.VisualGateError,"ALREADY_EXISTS"):
                subject.run(root,MANIFEST,cv2,np,write=True)

    def test_forged_gold_and_corrupted_source_sha_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            setup(root,synthetic(),cv_change={"arrow_direction_verified":True})
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.run(root,MANIFEST,cv2,np,write=True)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            private=setup(root,synthetic())
            image=private/"b31_source_only_page126.private.png"
            image.write_bytes(image.read_bytes()+b"tamper")
            with self.assertRaisesRegex(subject.VisualGateError,"PROVENANCE_INVALID"):
                subject.run(root,MANIFEST,cv2,np)

    def test_png_ihdr_dimensions_rejected_before_cv_decode(self):
        png=bytearray(synthetic())
        png[16:20]=(25000).to_bytes(4,"big")
        png[20:24]=(25000).to_bytes(4,"big")
        with self.assertRaisesRegex(subject.VisualGateError,"DIMENSIONS"):
            subject._image(bytes(png),{"render_width":25000,
                                       "render_height":25000},cv2,np)

    def test_empty_directory_not_created(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            with self.assertRaises(subject.VisualGateError):
                subject.run(root,MANIFEST,cv2,np,write=True)
            self.assertFalse((root/"semantic_gate").exists())

    def test_short_segment_no_tip(self):
        m=np.ones((160,240),dtype=bool)
        self.assertIsNone(subject.wing_score(m,[12.,12.],[0.,12.]))


if __name__=="__main__":
    unittest.main()
