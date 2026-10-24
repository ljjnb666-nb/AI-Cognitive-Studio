"""No-LLM synthetic source-bound five-book three-engine textual overlap."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_fivebook_three_engine_crossbook as s
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    (folder/s.V7).write_text("PRIVATE FIVEBOOK SOURCE",encoding="utf-8")
    five={"books":5,"same_source_focus_pages":5,
          "all_five_real_standard_ocr_succeeded":True,
          "actual_standard_ocr_success_pages":5,
          "cer":None,"cloud_calls":0,"model_downloads":0,"rows":[]}
    original={"same_source_page_count":5,"no_new_model_inference":True,
              "corpus_id":"SYNTHETIC","rows":[]}
    rapid={"pages":[]}
    b15={"corpus_id":"SYNTHETIC",
         "third_engine_actual_full_page_ocr_completed":True,
         "pairs":[]}
    for book in s.ALL_BOOKS:
        physical={"B03":67,"B08":64,"B15":109,"B29":72,"B31":126}[book]
        page="ABCDE"+book+"xyz"
        mineru="ABCDE"
        std="ABCD"
        psha=hashlib.sha256(("original-single-"+book).encode()).hexdigest()
        rapidsha=hashlib.sha256(("rapid-row-"+book).encode()).hexdigest()
        mineru_path=folder/(s.B31_MD if book=="B31" else s.file_names(book)[1])
        mineru_path.parent.mkdir(parents=True,exist_ok=True)
        mineru_path.write_text(mineru,encoding="utf-8")
        worker_path=(folder/s.STANDARD_WORKER if book=="B15"
                     else s.standard_paths(folder,book)[1])
        worker_path.parent.mkdir(parents=True,exist_ok=True)
        payload={"pipeline":"REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU",
                 "ocr_explicitly_enabled":True,"duration_ms":1000,
                 "text_item_count":1,"picture_item_count":0,
                 "table_item_count":0,"private_markdown":std}
        worker_path.write_text(json.dumps(payload,ensure_ascii=False),encoding="utf-8")
        original["rows"].append({
            "book_id":book,"physical_page":physical,
            "source_single_pdf_sha256_private":psha,
            "rapid_private_rows_sha256":rapidsha,
            "mineru_private_markdown_sha256":
                hashlib.sha256(mineru.encode()).hexdigest(),
            "rapidocr_normalized_alnum_chars":len(s.lexical(page)),
            "mineru_nonimage_normalized_alnum_chars":len(s.lexical(mineru)),
        })
        five["rows"].append({
            "book_id":book,"physical_page":physical,
            "source_page_sha256_private":psha,
            "status":"REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS",
            "normalized_characters":len(s.lexical(std)),
            "duration_ms":1000,"text_item_count":1,"picture_item_count":0,
        })
        rapid["pages"].append({
            "book_id":book,"physical_page":physical,
            "private_rows_sha256":rapidsha,
            "rapidocr_private_rows":[{"text":page}],
        })
        if book=="B15":
            views=(s.lexical(page),s.lexical(mineru),s.lexical(std))
            b15["pairs"]=[s.numeric_pair(s.ENGINES[i],s.ENGINES[j],
                           views[i],views[j]) for i,j in s.PAIR_INDICES]
    return folder,five,original,rapid,b15


class FiveCrossbookTests(unittest.TestCase):
    def compute(self,root,folder,five,original,rapid,b15,*,write=False,audit=False):
        with patch.object(s,"_private_folder",return_value=folder):
            return s.execute(root,{},write=write,audit=audit,
                five_fn=lambda r,m,audit:five,
                original_fn=lambda r,m,audit:original,
                rapid_fn=lambda r,m:rapid,
                b15_fn=lambda r,m,audit:b15)

    def test_all_five_three_pairs_from_frozen_ocr_and_privacy(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,five,original,rapid,b15=fixture(root)
            result=self.compute(root,folder,five,original,rapid,b15,write=True)
            self.assertEqual(result["same_original_page_count"],5)
            self.assertEqual(len(result["rows"]),5)
            self.assertEqual(sum(len(x["pairs"]) for x in result["rows"]),15)
            self.assertTrue(result["rapidocr_model_shared_between_two_paths"])
            self.assertIsNone(result["cer"])
            self.assertEqual(self.compute(root,folder,five,original,rapid,b15,
                                          audit=True),result)
            public=(folder/s.REPORT).read_text("utf-8")
            self.assertNotIn("ABCDE",public)
            self.assertNotIn("PRIVATE FIVEBOOK SOURCE",public)
            self.assertNotIn("private_markdown",public)
            with self.assertRaisesRegex(VisualGateError,"REPORT_ALREADY_EXISTS"):
                self.compute(root,folder,five,original,rapid,b15,write=True)

    def test_incomplete_standard_run_is_not_an_agreement_result(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,five,original,rapid,b15=fixture(root)
            five["all_five_real_standard_ocr_succeeded"]=False
            with self.assertRaisesRegex(VisualGateError,"ORIGINAL_SOURCE_GATE"):
                self.compute(root,folder,five,original,rapid,b15,write=True)
            self.assertFalse((folder/s.REPORT).exists())

    def test_source_identity_and_mineru_sha_tamper_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,five,original,rapid,b15=fixture(root)
            original["rows"][0]["source_single_pdf_sha256_private"]="f"*64
            with self.assertRaisesRegex(VisualGateError,"SAME_PAGE_SHA_CHANGED"):
                self.compute(root,folder,five,original,rapid,b15,write=True)
            original["rows"][0]["source_single_pdf_sha256_private"]=five["rows"][0][
                "source_page_sha256_private"]
            filename=folder/s.file_names("B03")[1]
            filename.write_text("PRIVATE changed",encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError,"MINERU_MD_SHA_CHANGED"):
                self.compute(root,folder,five,original,rapid,b15,write=True)

    def test_b15_v5_pair_receipt_is_independent_anchor(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,five,original,rapid,b15=fixture(root)
            b15["pairs"][1]["ordered_common_subsequence_characters"]+=1
            with self.assertRaisesRegex(VisualGateError,"B15_V5_CONFLICT"):
                self.compute(root,folder,five,original,rapid,b15,write=True)

    def test_frozen_report_is_recomputed_not_merely_parsed(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,five,original,rapid,b15=fixture(root)
            self.compute(root,folder,five,original,rapid,b15,write=True)
            (folder/s.REPORT).write_text("{}",encoding="utf-8")
            with self.assertRaisesRegex(VisualGateError,"FROZEN_REPORT_CHANGED"):
                self.compute(root,folder,five,original,rapid,b15,audit=True)


if __name__=="__main__":
    unittest.main()
