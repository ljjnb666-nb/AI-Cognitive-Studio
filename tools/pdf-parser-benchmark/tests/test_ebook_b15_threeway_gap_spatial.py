"""Two deterministic OCR subsequence anchors & 3x3 source evidence; no models."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b15_threeway_gap_spatial as subject
from ebook_fivebook_text_consensus import lexical
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    (folder/subject.V5).write_text("PRIVATE V5 FROZEN RECEIPT",encoding="utf-8")
    texts=["a","b","c","d","e","f","g","uvwxyz","h"]
    boxes=[]
    for k,text in enumerate(texts):
        x=(k%3)*33+5
        y=(k//3)*33+5
        boxes.append({"text":text,"quad":[[x,y],[x+2,y],[x+2,y+2],[x,y+2]]})
    m="abcdefgh"
    std="abcdefg"
    md=folder/subject.file_names("B15")[1]
    md.write_text(m,encoding="utf-8")
    worker=folder/subject.STANDARD_WORKER
    worker.write_text(json.dumps({
        "pipeline":"REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU",
        "ocr_explicitly_enabled":True,"private_markdown":std,
    }),encoding="utf-8")
    baseline={
        "book_id":"B15","physical_page":109,"corpus_id":"TEST",
        "third_engine_actual_full_page_ocr_completed":True,
        "source_same_original_book_and_physical_page":True,
        "cer":None,"new_ocr_calls":0,
        "private_mineru_markdown_sha256":hashlib.sha256(md.read_bytes()).hexdigest(),
        "private_standard_worker_sha256":hashlib.sha256(worker.read_bytes()).hexdigest(),
        "private_standalone_rapidocr_rows_sha256":"b"*64,
        "engines":[{"normalized_characters":len("".join(texts))},
                   {"normalized_characters":len(m)},
                   {"normalized_characters":len(std)}],
        "pairs":[{"ordered_common_subsequence_characters":v,
                  "sequence_order_gap_not_accuracy":0} for v in (8,7,7)],
    }
    spatial={
        "corpus_id":"TEST","original_source_pdf_sha256_private":"a"*64,
        "cells_3x3_row_major":[{"normalized_characters":len(s)} for s in texts],
    }
    order={"corpus_id":"TEST","rapidocr_line_count":9,
           "rapidocr_chars":len("".join(texts))}
    rapid={"pages":[{
        "book_id":"B15","physical_page":109,
        "private_rows_sha256":"b"*64,
        "source_document_sha256":"a"*64,
        "render_png_sha256":"c"*64,
        "rapidocr_line_count":9,
        "rapidocr_private_rows":boxes,
    }]}
    native={"rows":[{
        "book_id":"B15","source_document_sha256":"a"*64,
        "pages":[{
            "physical_page":109,
            "ocr_focus_width":100,"ocr_focus_height":100,
            "ocr_focus_png_sha256":"c"*64,
        }],
    }]}
    return folder,baseline,spatial,order,rapid,native


class GapTests(unittest.TestCase):
    def bind(self,folder,baseline,spatial,order,rapid,native):
        stack=ExitStack()
        for name,result in (("_private_folder",folder),("audit_three",baseline),
                            ("audit_spatial",spatial),("audit_order",order),
                            ("audit_rapid",rapid),("audit_native",native)):
            stack.enter_context(patch.object(subject,name,return_value=result))
        return stack

    def test_both_valid_anchors_and_repeat_character_ambiguity(self):
        left=subject.complete_subsequence_positions("ababa","aba")
        right=subject.complete_subsequence_positions("ababa","aba",reverse=True)
        self.assertEqual(left,{0,1,2})
        self.assertEqual(right,{2,3,4})
        cells=subject.aggregate_unmatched([0,1,2,3,4],"ababa","aba")
        self.assertEqual(sum(c["extra_vs_target_earliest_anchor"] for c in cells),2)
        self.assertEqual(sum(c["extra_vs_target_latest_anchor"] for c in cells),2)
        self.assertGreater(sum(c["anchor_assignment_disagreement"]
                               for c in cells),0)

    def test_no_complete_subsequence_is_explicitly_rejected(self):
        with self.assertRaisesRegex(VisualGateError,"NOT_COMPLETE"):
            subject.complete_subsequence_positions("abc","abd")
        with self.assertRaisesRegex(VisualGateError,"NOT_COMPLETE"):
            subject.complete_subsequence_positions("abc","abd",reverse=True)
        with self.assertRaisesRegex(VisualGateError,"OUT_OF_BOUNDS"):
            subject.aggregate_unmatched([12,0,0],"abc","ab")

    def test_frozen_source_nine_cells_localize_extra_without_truth(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            folder,base,spatial,order,rapid,native=fixture(root)
            with self.bind(folder,base,spatial,order,rapid,native):
                result=subject.execute(root,{},write=True)
                self.assertEqual(result["rapidocr_minus_mineru_characters"],6)
                self.assertEqual(result["rapidocr_minus_docling_characters"],7)
                self.assertEqual(result["mineru_minus_docling_characters"],1)
                bottom_middle=result["extra_vs_mineru_3x3_two_anchor_alignments"][7]
                self.assertEqual(bottom_middle["extra_vs_target_earliest_anchor"],6)
                self.assertEqual(bottom_middle["extra_vs_target_latest_anchor"],6)
                self.assertTrue(result["subsequence_complete_in_both_anchors"])
                self.assertIsNone(result["cer"])
                report=(folder/subject.REPORT).read_text("utf-8")
                for raw in ("uvwxyz","abcdefg","PRIVATE V5 FROZEN RECEIPT",
                            "quad","text"):
                    # 'text' is allowed only as part of enum names/description;
                    # no raw quoted text fields are present.
                    if raw!="text":
                        self.assertNotIn(raw,report)
                self.assertEqual(subject.execute(root,{},audit=True),result)
                with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                    subject.execute(root,{},write=True)

    def test_frozen_sha_tamper_rejects_without_side_effects(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            folder,base,spatial,order,rapid,native=fixture(root)
            with self.bind(folder,base,spatial,order,rapid,native):
                (folder/subject.STANDARD_WORKER).write_text("tampered",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"STANDARD_SHA_CHANGED"):
                    subject.execute(root,{},write=True)
                self.assertFalse((folder/subject.REPORT).exists())

    def test_original_page_grid_change_and_report_tamper_block_audit(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            folder,base,spatial,order,rapid,native=fixture(root)
            with self.bind(folder,base,spatial,order,rapid,native):
                spatial["cells_3x3_row_major"][7]["normalized_characters"]=5
                with self.assertRaisesRegex(VisualGateError,"SPATIAL_RECEIPT_CHANGED"):
                    subject.execute(root,{},write=True)
                spatial["cells_3x3_row_major"][7]["normalized_characters"]=6
                subject.execute(root,{},write=True)
                (folder/subject.REPORT).write_text("{}",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"PRIVATE_REPORT_CHANGED"):
                    subject.execute(root,{},audit=True)


if __name__=="__main__":
    unittest.main()
