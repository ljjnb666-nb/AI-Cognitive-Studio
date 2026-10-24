"""Synthetic B15 disagreement triage: different outputs are not ground truth."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from contextlib import ExitStack

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b15_disagreement_triage as subject
from ebook_private_glm_visual_reference import VisualGateError


def synthetic(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    md_path=folder/subject.file_names("B15")[1]
    # HTML + 16K image bytes must never be counted as recognized text.
    markdown="## 你好abc\n![private](data:image/png;base64,"+"QUJD"*4000+")"
    md_path.write_text(markdown,encoding="utf-8")
    rows=[{"text":"你好abc"},{"text":"额外的孤立文本"},{"text":"XYZ"}]
    rapid_norm=subject.lexical("\n".join(x["text"] for x in rows))
    mineru_norm=subject.lexical(subject.mineru_lexical_source(markdown))
    b15={"book_id":"B15","physical_page":109,
        "same_sha_pinned_original_page":True,
        "source_single_pdf_sha256_private":"1"*64,
        "rapid_private_rows_sha256":"2"*64,
        "mineru_private_markdown_sha256":hashlib.sha256(
            markdown.encode("utf-8")).hexdigest(),
        "rapidocr_normalized_alnum_chars":len(rapid_norm),
        "mineru_nonimage_normalized_alnum_chars":len(mineru_norm),
        "symmetric_trigram_dice_not_accuracy":0.45}
    consensus={"corpus_id":"SYNTHETIC_ONLY",
               "same_source_page_count":5,
               "agreement_is_not_accuracy":True,"cer":None,
               "rows":[b15]}
    rapid={"corpus_id":"SYNTHETIC_ONLY","ocr_pages":5,
           "pages":[{"book_id":"B15","physical_page":109,
                     "private_rows_sha256":"2"*64,
                     "rapidocr_private_rows":rows}]}
    return folder,md_path,consensus,rapid


class B15DisagreementTests(unittest.TestCase):
    def inputs(self,folder,consensus,rapid):
        stack=ExitStack()
        stack.enter_context(patch.object(subject,"audit_consensus",
                                         return_value=consensus))
        stack.enter_context(patch.object(subject,"audit_rapidocr",
                                         return_value=rapid))
        stack.enter_context(patch.object(subject,"_private_folder",
                                         return_value=folder))
        return stack

    def test_presence_bands_are_not_gold_or_accuracy(self):
        rows=subject.line_support(["你好abc","孤立文本内容","X",""],"你好abc")
        self.assertEqual([x["presence_band"] for x in rows],
                         ["HIGH","ZERO","TOO_SHORT","EMPTY"])
        self.assertEqual(rows[0]["potential_presence_fraction_not_accuracy"],1)
        self.assertEqual(rows[1]["potential_presence_fraction_not_accuracy"],0)

    def test_private_frozen_receipt_and_no_user_text_or_image_payload(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); folder,md,consensus,rapid=synthetic(root)
            with self.inputs(folder,consensus,rapid):
                result=subject.execute(root,{},write=True)
                self.assertEqual(result["rapidocr_line_count"],3)
                self.assertEqual(result["potential_line_support_buckets"]["HIGH"],1)
                self.assertEqual(result["potential_line_support_buckets"]["ZERO"],2)
                self.assertIsNone(result["cer"])
                self.assertFalse(result["root_cause_verified"])
                self.assertEqual(sum(x["line_count"] for x in result["ordinal_quarters"]),3)
                stored=(folder/subject.REPORT).read_text("utf-8")
                for secret in ("你好","额外的孤立文本","QUJD","private"):
                    self.assertNotIn(secret,stored)
                self.assertEqual(subject.execute(root,{},audit=True),result)
                with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                    subject.execute(root,{},write=True)

    def test_markdown_tamper_fails_before_new_report(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); folder,md,consensus,rapid=synthetic(root)
            with self.inputs(folder,consensus,rapid):
                md.write_text("tampered",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"SHA_CHANGED"):
                    subject.execute(root,{},write=True)
                self.assertFalse((folder/subject.REPORT).exists())

    def test_wrong_page_or_rapid_sha_and_receipt_mutation_fail_closed(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);folder,md,consensus,rapid=synthetic(root)
            with self.inputs(folder,consensus,rapid):
                rapid["pages"][0]["physical_page"]=110
                with self.assertRaisesRegex(VisualGateError,"IDENTITY_INVALID"):
                    subject.execute(root,{},write=True)
                rapid["pages"][0]["physical_page"]=109
                rapid["pages"][0]["private_rows_sha256"]="f"*64
                with self.assertRaisesRegex(VisualGateError,"RECEIPT_CHANGED"):
                    subject.execute(root,{},write=True)
                rapid["pages"][0]["private_rows_sha256"]="2"*64
                subject.execute(root,{},write=True)
                report=folder/subject.REPORT
                report.write_text("{}",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"FROZEN_REPORT_CHANGED"):
                    subject.execute(root,{},audit=True)


if __name__=="__main__":
    unittest.main()
