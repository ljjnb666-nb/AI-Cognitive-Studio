"""B15 coarse page geometry has independent source-bound numerical receipts."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from contextlib import ExitStack

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b15_spatial_disagreement as subject
from ebook_private_glm_visual_reference import VisualGateError


def fake_inputs(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    (folder/subject.B15_REPORT).write_text("FAKE_UPSTREAM_LINE","utf-8")
    (folder/subject.ORDER_REPORT).write_text("FAKE_UPSTREAM_ORDER","utf-8")
    positions=[(5,5),(50,5),(95,5),(5,50),(50,50),
               (95,50),(5,95),(50,95),(95,95)]
    quad=lambda x,y:[[x,y],[x+1,y],[x+1,y+1],[x,y+1]]
    texts=["ABC","DEF","GHI","JKL","MNO","PQR","STU","VWX","YZ0"]
    bands=["HIGH","ZERO","LOW","TOO_SHORT","MEDIUM","HIGH",
           "ZERO","LOW","HIGH"]
    metadata=[{"line_index":i,"normalized_chars":3,"presence_band":bands[i]}
              for i in range(9)]
    prior={"book_id":"B15","physical_page":109,"corpus_id":"TEST",
           "rapidocr_alnum_chars":27,"private_line_metadata_only":metadata,
           "potential_line_support_buckets":{b:bands.count(b) for b in subject.BANDS},
           "rapid_private_rows_sha256":"a"*64,
           "mineru_private_markdown_sha256":"b"*64}
    ordered={"book_id":"B15","physical_page":109,"corpus_id":"TEST",
             "root_cause_verified":False,"cer":None,"new_model_inferences":0,
             "rapidocr_rows_sha256_private":"a"*64,
             "mineru_markdown_sha256_private":"b"*64}
    pngsha="c"*64
    docsha="d"*64
    native={"rows":[{"book_id":"B15","source_document_sha256":docsha,
                     "pages":[{"physical_page":109,"ocr_focus_width":100,
                               "ocr_focus_height":100,
                               "ocr_focus_png_sha256":pngsha}]}]}
    rapid={"pages":[{"book_id":"B15","physical_page":109,
                     "render_png_sha256":pngsha,
                     "source_document_sha256":docsha,
                     "private_rows_sha256":"a"*64,
                     "rapidocr_private_rows":[{"text":t,"quad":quad(x,y),"score":.92}
                       for t,(x,y) in zip(texts,positions)]}]}
    return folder,prior,ordered,native,rapid


class SpatialTests(unittest.TestCase):
    def bind(self,folder,prior,ordered,native,rapid):
        stack=ExitStack()
        for key,obj in (("audit_b15",prior),("audit_order",ordered),
                        ("audit_native",native),("audit_rapid",rapid)):
            stack.enter_context(patch.object(subject,key,return_value=obj))
        stack.enter_context(patch.object(subject,"_private_folder",
                                         return_value=folder))
        return stack

    def test_grid_is_actual_3x3_box_center_not_ocr_order(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);folder,prior,ordered,native,rapid=fake_inputs(root)
            with self.bind(folder,prior,ordered,native,rapid):
                result=subject.execute(root,{},write=True)
                self.assertEqual(result["spatial_cell_count"],9)
                self.assertEqual([x["line_count"] for x in result["cells_3x3_row_major"]],
                                 [1]*9)
                self.assertEqual(result["zero_or_low_lines"],4)
                self.assertEqual([x["zero_or_low_lines"]
                                  for x in result["cells_3x3_row_major"]],
                                 [0,1,1,0,0,0,1,1,0])
                self.assertIsNone(result["cer"])
                self.assertIsNone(result["which_ocr_is_correct"])
                report=(folder/subject.REPORT).read_text("utf-8")
                for secret in ("FAKE_UPSTREAM_LINE","ABC","PQR","quad",
                               "confidence","coordinates"):
                    self.assertNotIn(secret,report)
                self.assertEqual(subject.execute(root,{},audit=True),result)
                with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                    subject.execute(root,{},write=True)

    def test_invalid_quad_and_boundary(self):
        quad=[[0,0],[100,0],[100,100],[0,100]]
        self.assertEqual(subject.coarse_cell(quad,100,100),4)
        with self.assertRaisesRegex(VisualGateError,"OUTSIDE_ORIGINAL_IMAGE"):
            subject.coarse_cell([[120,0],[0,0],[1,1],[1,0]],100,100)
        with self.assertRaisesRegex(VisualGateError,"QUAD_INVALID"):
            subject.coarse_cell([[float("nan"),0],[0,0],[1,1],[1,0]],100,100)

    def test_tamper_prior_sha_and_box_fail_closed(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);folder,prior,ordered,native,rapid=fake_inputs(root)
            with self.bind(folder,prior,ordered,native,rapid):
                ordered["rapidocr_rows_sha256_private"]="e"*64
                with self.assertRaisesRegex(VisualGateError,"PRIOR_SOURCE_IDENTITY_CHANGED"):
                    subject.execute(root,{},write=True)
                ordered["rapidocr_rows_sha256_private"]="a"*64
                rapid["pages"][0]["render_png_sha256"]="f"*64
                with self.assertRaisesRegex(VisualGateError,"ORIGINAL_SOURCE_SHA_CONFLICT"):
                    subject.execute(root,{},write=True)
                rapid["pages"][0]["render_png_sha256"]="c"*64
                rapid["pages"][0]["rapidocr_private_rows"][1]["quad"][0][0]=101
                with self.assertRaisesRegex(VisualGateError,"OUTSIDE_ORIGINAL_IMAGE"):
                    subject.execute(root,{},write=True)
                self.assertFalse((folder/subject.REPORT).exists())

    def test_existing_receipt_tamper_cannot_be_audited(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);folder,prior,ordered,native,rapid=fake_inputs(root)
            with self.bind(folder,prior,ordered,native,rapid):
                subject.execute(root,{},write=True)
                report=folder/subject.REPORT
                report.write_text("{}",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"FROZEN_REPORT_CHANGED"):
                    subject.execute(root,{},audit=True)


if __name__=="__main__":
    unittest.main()
