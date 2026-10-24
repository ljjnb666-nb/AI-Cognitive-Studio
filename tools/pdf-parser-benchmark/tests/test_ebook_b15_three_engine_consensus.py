"""No OCR and no private content: three-engine same-page numeric regressions."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b15_three_engine_consensus as s
from ebook_fivebook_text_consensus import lexical,mineru_lexical_source
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    original="龙车路甲乙壹贰abcDEF"
    standard_md="## 龙车路甲乙abcDEF"
    mineru_md="龙车路甲乙壹贰"
    mdfile=folder/s.file_names("B15")[1]
    mdfile.write_text(mineru_md,encoding="utf-8")
    worker={"pipeline":"REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU",
            "ocr_explicitly_enabled":True,"private_markdown":standard_md}
    w=folder/s.STANDARD_WORKER
    w.write_text(json.dumps(worker,ensure_ascii=False),encoding="utf-8")
    (folder/"b15_docling_standard_rapidocr_real.v4.private.json").write_text(
        "PRIVATE_STANDARD_RECEIPT",encoding="utf-8")
    (folder/"b15_spatial_disagreement_heatmap_3x3.private.json").write_text(
        "PRIVATE_SPATIAL_RECEIPT",encoding="utf-8")
    original_sha="a"*64
    rows=[{"text":original[:6]},{"text":original[6:]}]
    normalized=lexical("\n".join(r["text"] for r in rows))
    rapid={"pages":[{"book_id":"B15","physical_page":109,
                     "source_document_sha256":original_sha,
                     "private_rows_sha256":"b"*64,
                     "rapidocr_line_count":2,"rapidocr_private_rows":rows}]}
    order={"book_id":"B15","physical_page":109,"corpus_id":"SYNTHETIC",
           "rapid_private_rows_sha256":"b"*64,
           "rapidocr_line_count":2,
           "rapidocr_alnum_chars":len(normalized),
           "mineru_nonimage_alnum_chars":len(lexical(mineru_md)),
           "mineru_private_markdown_sha256":hashlib.sha256(
               mineru_md.encode("utf-8")).hexdigest()}
    spatial={"book_id":"B15","physical_page":109,"corpus_id":"SYNTHETIC",
             "original_source_pdf_sha256_private":original_sha}
    std={"book_id":"B15","physical_page":109,"corpus_id":"SYNTHETIC",
         "status":"REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS",
         "actual_ocr_success":True,"cer":None,
         "new_cloud_calls":0,"new_model_downloads":0,
         "worker_sha256_private":hashlib.sha256(w.read_bytes()).hexdigest(),
         "markdown_normalized_character_count":len(lexical(
             mineru_lexical_source(standard_md)))}
    return folder,mdfile,rapid,order,spatial,std


class ConsensusTests(unittest.TestCase):
    def bind(self,folder,rapid,order,spatial,std):
        stack=ExitStack()
        for name,v in (("_private_folder",folder),("audit_rapid",rapid),
                       ("audit_order",order),("audit_spatial",spatial),
                       ("audit_standard",std)):
            if name=="_private_folder":
                stack.enter_context(patch.object(s,name,return_value=v))
            else:
                stack.enter_context(patch.object(s,name,return_value=v))
        return stack

    def test_three_pairs_exact_source_private_output_and_audit(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);f,md,rapid,order,spatial,std=fixture(root)
            with self.bind(f,rapid,order,spatial,std):
                report=s.execute(root,{},write=True)
                self.assertEqual(len(report["engines"]),3)
                self.assertEqual(len(report["pairs"]),3)
                self.assertTrue(report["third_engine_actual_full_page_ocr_completed"])
                self.assertIsNone(report["cer"])
                self.assertIsNone(report["quality_winner"])
                self.assertGreater(report["pairs"][0]["ordered_common_subsequence_characters"],0)
                raw=(f/s.REPORT).read_text("utf-8")
                for token in ("龙车路甲乙","PRIVATE_STANDARD_RECEIPT",
                              "PRIVATE_SPATIAL_RECEIPT","private_markdown"):
                    self.assertNotIn(token,raw)
                self.assertEqual(s.execute(root,{},audit=True),report)
                with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                    s.execute(root,{},write=True)

    def test_dice_and_lcs_are_diagnostics_not_gold(self):
        x=s.numeric_pair("A","B","abcde","edcba")
        self.assertEqual(x["unordered_common_multiset_characters"],5)
        self.assertEqual(x["ordered_common_subsequence_characters"],1)
        self.assertEqual(x["sequence_order_gap_not_accuracy"],4)
        self.assertEqual(x["symmetric_trigram_dice_not_accuracy"],0)
        self.assertEqual(s.numeric_pair("A","B","abc","abc")[
            "symmetric_trigram_dice_not_accuracy"],1)
        with self.assertRaisesRegex(VisualGateError,"SOURCE_EMPTY"):
            s.numeric_pair("A","B","","abc")

    def test_upstream_sha_tamper_rejected_before_new_report(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);f,md,rapid,order,spatial,std=fixture(root)
            with self.bind(f,rapid,order,spatial,std):
                md.write_text("changed",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"MINERU_SOURCE_SHA_CHANGED"):
                    s.execute(root,{},write=True)
                self.assertFalse((f/s.REPORT).exists())

    def test_fake_ocr_success_and_changed_worker_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);f,md,rapid,order,spatial,std=fixture(root)
            with self.bind(f,rapid,order,spatial,std):
                std["actual_ocr_success"]=False
                with self.assertRaisesRegex(VisualGateError,"UPSTREAM_IDENTITY"):
                    s.execute(root,{},write=True)
                std["actual_ocr_success"]=True
                (f/s.STANDARD_WORKER).write_text("{}",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"STANDARD_WORKER_SHA_CHANGED"):
                    s.execute(root,{},write=True)

    def test_report_frozen_tamper_rejected_without_new_ocr(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);f,md,rapid,order,spatial,std=fixture(root)
            with self.bind(f,rapid,order,spatial,std):
                s.execute(root,{},write=True)
                (f/s.REPORT).write_text("{}",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"REPORT_TAMPERED"):
                    s.execute(root,{},audit=True)


if __name__=="__main__":
    unittest.main()
