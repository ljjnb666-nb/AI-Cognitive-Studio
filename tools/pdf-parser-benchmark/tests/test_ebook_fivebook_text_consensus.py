"""Synthetic five-book agreement: no OCR gold and no private text disclosed."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from contextlib import ExitStack

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_fivebook_text_consensus as subject
from ebook_b31_mineru_markdown_structure import count_structure


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    items=[]; rapid=[]
    for i,book in enumerate(subject.ALL_BOOKS):
        page=126 if book=="B31" else i+11
        # A 40k character Data URI MUST NOT be treated as OCR text.
        markdown="## 你好 世界 ABC\n\n![private](data:image/png;base64,"+("QUJD"*10000)+")"
        name=(subject.B31_MD if book=="B31" else subject.file_names(book)[1])
        (folder/name).write_text(markdown,encoding="utf-8")
        counts=count_structure(markdown)
        texts=[{"text":"你好世界ABC","quad":[],"score":.95}]
        row={
            "book_id":book,"physical_page":page,
            "rapidocr_lines":1,"rapidocr_characters":len(texts[0]["text"]),
            "rapidocr_duration_ms":15,
            "source_pdf_sha256_private":f"{i+1:064x}",
            "mineru_markdown_raw_chars":counts["markdown_raw_character_count"],
            "mineru_image_data_uri_count":counts["embedded_image_data_uri_count"],
            "mineru_base64_image_payload_chars":counts["embedded_image_data_uri_raw_characters"],
            "mineru_nonimage_nonwhitespace_residue":
                counts["nonwhitespace_nonimage_markdown_residue_chars"],
        }
        items.append(row)
        rapid.append({
            "book_id":book,"physical_page":page,
            "rapidocr_line_count":1,"rapidocr_char_count":len(texts[0]["text"]),
            "duration_ms":15,"private_rows_sha256":f"{i+10:064x}",
            "rapidocr_private_rows":texts,
        })
    return folder,{"corpus_id":"PRIVATE_SYNTHETIC",
        "identical_focus_pages":5,"new_mineru_inferences":4,
        "b31_mineru_result_reused":True,"rows":items
    },{"ocr_books":5,"ocr_pages":5,"pages":rapid}


class ConsensusTests(unittest.TestCase):
    def test_images_not_lexical_text(self):
        raw="![secret](data:image/png;base64,"+("QUJD"*2000)+") 你好"
        cleaned=subject.lexical(subject.mineru_lexical_source(raw))
        self.assertEqual(cleaned,"你好")
        self.assertNotIn("secret",cleaned)

    def test_unicode_normalization_and_multiset_agreement(self):
        self.assertEqual(subject.lexical("ＡＢＣ， 你好！"),"abc你好")
        a=subject.agreement("abc你好","abc你好")
        self.assertEqual(a["symmetric_trigram_dice_not_accuracy"],1)
        b=subject.agreement("abcde","fghij")
        self.assertEqual(b["symmetric_trigram_dice_not_accuracy"],0)
        self.assertTrue(b["agreement_not_correctness"])

    def test_empty_does_not_create_perfect_ocr_claim(self):
        self.assertIsNone(subject.agreement("","")["symmetric_trigram_dice_not_accuracy"])
        self.assertEqual(subject.agreement("","abc")["symmetric_trigram_dice_not_accuracy"],0)

    def sources(self,root,matrix,rapid,folder):
        stack=ExitStack()
        stack.enter_context(patch.object(subject,"combined",return_value=matrix))
        stack.enter_context(patch.object(subject,"audit_rapidocr",return_value=rapid))
        stack.enter_context(patch.object(subject,"_private_folder",return_value=folder))
        return stack

    def test_true_five_book_agreement_without_model_run_or_leaks(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            folder,matrix,rapid=fixture(root)
            with self.sources(root,matrix,rapid,folder):
                result=subject.execute(root,{},write=True)
                self.assertEqual(len(result["rows"]),5)
                self.assertEqual(result["paid_provider_calls"],0)
                self.assertTrue(result["no_new_model_inference"])
                self.assertIsNone(result["cer"])
                for item in result["rows"]:
                    self.assertEqual(item["symmetric_trigram_dice_not_accuracy"],1)
                    self.assertEqual(item["mineru_nonimage_normalized_alnum_chars"],7)
                self.assertNotIn("你好",json.dumps(result,ensure_ascii=False))
                self.assertNotIn("QUJD",json.dumps(result))
                self.assertEqual(subject.execute(root,{},audit=True),result)
                with self.assertRaisesRegex(subject.VisualGateError,"ALREADY_EXISTS"):
                    subject.execute(root,{},write=True)

    def test_missing_or_tampered_private_markdown_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            folder,matrix,rapid=fixture(root)
            with self.sources(root,matrix,rapid,folder):
                (folder/subject.file_names("B08")[1]).write_text("tampered",encoding="utf-8")
                with self.assertRaisesRegex(subject.VisualGateError,"COUNTS_CHANGED"):
                    subject.execute(root,{},write=True)
                self.assertFalse((folder/subject.REPORT).exists())

    def test_mismatched_physical_page_fails_before_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            folder,matrix,rapid=fixture(root)
            rapid["pages"][0]["physical_page"]=777
            with self.sources(root,matrix,rapid,folder):
                with self.assertRaisesRegex(subject.VisualGateError,"PAGE_MISMATCH"):
                    subject.execute(root,{},write=True)
                self.assertFalse((folder/subject.REPORT).exists())

    def test_false_gold_and_modified_receipt_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            folder,matrix,rapid=fixture(root)
            with self.sources(root,matrix,rapid,folder):
                subject.execute(root,{},write=True)
                path=folder/subject.REPORT
                data=json.loads(path.read_text("utf-8"))
                data["cer"]=0.0
                path.write_text(json.dumps(data),encoding="utf-8")
                with self.assertRaisesRegex(subject.VisualGateError,"TAMPERED"):
                    subject.execute(root,{},audit=True)

    def test_lexical_budget_prevents_unbounded_expansion(self):
        with self.assertRaisesRegex(subject.VisualGateError,"TOO_LONG"):
            subject.lexical("字"*(subject.MAX_LEXICAL+1))


if __name__=="__main__":
    unittest.main()
