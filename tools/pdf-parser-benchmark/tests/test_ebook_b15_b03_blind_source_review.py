"""Synthetic provenance and blind-source image pack, no model or private OCR text."""
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b15_b03_blind_source_review as s
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    (folder/s.V8).write_bytes(b"SYNTHETIC V8 immutable source")
    (folder/s.V6).write_bytes(b"SYNTHETIC V6 immutable source")
    native={"selected_native_pages":24,"ocr_focus_image_count":5,
            "corpus_id":"SYNTHETIC","rows":[]}
    v8={"same_original_page_count":5,"independent_ocr_truth":None,
        "accuracy_winner":None,"corpus_id":"SYNTHETIC","rows":[]}
    v6={"book_id":"B15","physical_page":109,
        "no_independent_ocr_truth":True,"corpus_id":"SYNTHETIC",
        "multiple_alignment_choices_possible":False}
    for book,page,scope in s.TARGETS:
        png=b"PRIVATE ORIGINAL SOURCE RENDER ONLY "+book.encode("ascii")
        source=folder/f"{book}_p{page:04d}.private.png"
        source.write_bytes(png)
        native["rows"].append({"book_id":book,
            "source_document_sha256":"a"*64,
            "pages":[{"physical_page":page,
                      "ocr_focus_png":source.name,
                      "ocr_focus_png_sha256":s.sha(png),
                      "ocr_focus_width":300,"ocr_focus_height":300}]})
        v8["rows"].append({"book_id":book,"physical_page":page,
            "same_original_single_page_sha256_private":"b"*64,
            "actual_real_standard_ocr":True})
        if book=="B15":
            v6["original_page_png_sha256_private"]=s.sha(png)
    return folder,native,v8,v6


def renderer(png,w,h,scope):
    region=(0,0,w,h) if scope=="FULL" else (
        w//3,2*h//3,2*w//3,h)
    return (png if scope=="FULL" else
            b"SYNTHETIC REGION CROP NO OCR:"+png),region


class BlindReviewTests(unittest.TestCase):
    def run_packet(self,root,folder,native,v8,v6,*,write=False,audit=False,
                   render=renderer):
        with patch.object(s,"_private_folder",return_value=folder):
            return s.compute(root,{},write=write,audit=audit,render=render,
                native_fn=lambda r,m:native,
                v8_fn=lambda r,m,audit:v8,
                v6_fn=lambda r,m,audit:v6)

    def test_original_roi_and_full_page_packet_immutable_without_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,native,v8,v6=fixture(root)
            data=self.run_packet(root,folder,native,v8,v6,write=True)
            self.assertEqual(data["image_count"],2)
            self.assertEqual(data["reviewed_reference_count"],0)
            self.assertIsNone(data["cer"])
            self.assertFalse(data["independent_reference_created"])
            self.assertFalse(data["any_ocr_candidate_visible_in_review_packet"])
            for book,page,scope in s.TARGETS:
                stem=f"{book}_p{page:04d}_{scope}"
                form=s.frozen_json(folder/s.SUBDIR/(stem+".blank.private.json"),s.MAX_FORM)
                self.assertFalse(form["independent_review_performed"])
                self.assertIsNone(form["independent_transcript"])
                self.assertIsNone(form["reviewer_approval"])
                self.assertIn("UNREVIEWED",form["reference_status"])
            self.assertEqual(data,self.run_packet(root,folder,native,v8,v6,audit=True))
            with self.assertRaisesRegex(VisualGateError,"ALREADY_FROZEN"):
                self.run_packet(root,folder,native,v8,v6,write=True)

    def test_source_png_tamper_blocks_before_writing_packet(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,native,v8,v6=fixture(root)
            (folder/"B15_p0109.private.png").write_bytes(b"tampered")
            with self.assertRaisesRegex(VisualGateError,"PROVENANCE_FAILED"):
                self.run_packet(root,folder,native,v8,v6,write=True)
            self.assertFalse((folder/s.REPORT).exists())
            self.assertFalse((folder/s.SUBDIR).exists())

    def test_old_source_spatial_hash_mismatch_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,native,v8,v6=fixture(root)
            v6["original_page_png_sha256_private"]="0"*64
            with self.assertRaisesRegex(VisualGateError,"SPATIAL_B15_CHANGED"):
                self.run_packet(root,folder,native,v8,v6,write=True)

    def test_frozen_form_and_source_crop_sha_rechecked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,native,v8,v6=fixture(root)
            self.run_packet(root,folder,native,v8,v6,write=True)
            form=folder/s.SUBDIR/"B15_p0109_R3C2.blank.private.json"
            form.write_text("{}",encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError,"BLANK_FORM_MUTATED"):
                self.run_packet(root,folder,native,v8,v6,audit=True)
            # Restore source form by reconstructing from frozen metadata.
            img=folder/s.SUBDIR/"B15_p0109_R3C2.source.private.png"
            candidate=s.form("B15",109,"R3C2",
                             v6["original_page_png_sha256_private"],s.sha(img.read_bytes()))
            form.write_bytes((__import__("json").dumps(candidate,ensure_ascii=False,
                sort_keys=True,separators=(",",":"))+"\n").encode("utf-8"))
            img.write_bytes(b"ALTERED CROP")
            updated=s.form("B15",109,"R3C2",
                           v6["original_page_png_sha256_private"],s.sha(img.read_bytes()))
            form.write_bytes((__import__("json").dumps(updated,ensure_ascii=False,
                sort_keys=True,separators=(",",":"))+"\\n").encode("utf-8"))
            with self.assertRaisesRegex(VisualGateError,"FROZEN_REPORT_CHANGED"):
                self.run_packet(root,folder,native,v8,v6,audit=True)

    def test_wrong_crop_geometry_and_partial_packet_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);folder,native,v8,v6=fixture(root)
            def false_crop(png,w,h,scope):
                return b"cropped",(0,0,w,h)
            with self.assertRaisesRegex(VisualGateError,"CROP_RECT_CHANGED"):
                self.run_packet(root,folder,native,v8,v6,write=True,
                                render=false_crop)
            self.assertFalse((folder/s.REPORT).exists())
            self.assertFalse((folder/s.SUBDIR).exists())
            (folder/s.SUBDIR).mkdir()
            (folder/s.SUBDIR/"B15_p0109_R3C2.source.private.png").write_bytes(b"x")
            with self.assertRaisesRegex(VisualGateError,"PARTIAL_PACKET"):
                self.run_packet(root,folder,native,v8,v6,write=True)


if __name__=="__main__":
    unittest.main()
