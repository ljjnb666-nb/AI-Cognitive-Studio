"""Synthetic-only tests for consistent content and full printed-page CER scopes."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from ebook_fivebook_text_scope import classify_front_page_text, TextScopeError

POLICY={
    "only_visible_physical_page_text":True,
    "exclude_reverse_bleedthrough":True,
    "exclude_cross_page_inferred_text":True,
    "record_decoration_separately":True,
}
def block(name,role,value):
    from unicodedata import category
    return {
        "id":name,"type":role,"source_text_candidate":value,
        "characters_including_punctuation":len(value),
        "punctuation_characters":sum(category(c).startswith("P") for c in value),
    }

class SourceScopeTest(unittest.TestCase):
    def setUp(self):
        self.rows=[
            block("header","running_header","Chapter X"),
            block("body","body","A, B。"),
            block("aside","boxed_body","C！"),
            block("page","page_number","50"),
            block("design","background_decoration","PART"),
            block("back","reverse_bleedthrough","reversed letters"),
        ]

    def derive(self,rows=None,policy=None):
        return classify_front_page_text(
            self.rows if rows is None else rows,
            scope_decisions=POLICY if policy is None else policy,
        )

    def test_body_and_boxed_content_not_diluted_by_page_furniture(self):
        result=self.derive()
        self.assertEqual(result["reading_content"]["block_ids"],["body","aside"])
        self.assertEqual(result["reading_content"]["source_characters"],7)
        self.assertEqual(result["reading_content"]["punctuation_characters"],3)
        self.assertEqual(result["front_printed_text"]["block_ids"],["header","body","aside","page"])
        self.assertEqual(result["front_printed_text"]["source_characters"],18)

    def test_decoration_and_reverse_bleedthrough_never_counted_as_front_text(self):
        result=self.derive()
        self.assertEqual(result["separately_recorded_excluded_visuals"],[
            {"block_id":"design","role":"background_decoration"},
            {"block_id":"back","role":"reverse_bleedthrough"},
        ])
        self.assertFalse(result["automatic_gold_approval"])
        self.assertIsNone(result["all_ocr_engine_cer"])

    def test_all_output_authority_states_remain_false_even_with_complete_source_blocks(self):
        result=self.derive()
        for view in ("reading_content","front_printed_text"):
            self.assertIsNone(result[view]["cer"])
            self.assertFalse(result[view]["independent_gold_approved"])
        self.assertFalse(result["punctuation_and_reading_order_independently_approved"])

    def test_punctuation_and_printed_typography_are_preserved_in_source_lengths(self):
        z=self.derive([
            block("header","section_page","2－057"),
            block("text","body","“A”！？"),
        ])
        self.assertEqual(z["reading_content"]["source_characters"],5)
        self.assertEqual(z["reading_content"]["punctuation_characters"],4)
        self.assertEqual(z["front_printed_text"]["source_characters"],10)
        self.assertEqual(z["front_printed_text"]["punctuation_characters"],5)

    def test_missing_source_scope_policy_fails_closed(self):
        for field in POLICY:
            mod=dict(POLICY)
            del mod[field]
            with self.assertRaisesRegex(TextScopeError,"SOURCE_TEXT_SCOPE_INVALID"):
                self.derive(policy=mod)
        with self.assertRaisesRegex(TextScopeError,"SOURCE_TEXT_SCOPE_INVALID"):
            self.derive(policy={**POLICY,"exclude_reverse_bleedthrough":False})

    def test_unknown_roles_must_not_silently_enter_cer(self):
        with self.assertRaisesRegex(TextScopeError,"SOURCE_TEXT_BLOCK_INVALID"):
            self.derive(rows=[block("x","math_diagram","1+1=2")])

    def test_duplicate_identifiers_and_corrupt_character_counts_rejected(self):
        with self.assertRaisesRegex(TextScopeError,"SOURCE_TEXT_BLOCK_INVALID"):
            self.derive(rows=[self.rows[0],self.rows[0]])
        invalid=block("x","body","正文。")
        invalid["punctuation_characters"]=0
        with self.assertRaisesRegex(TextScopeError,"SOURCE_TEXT_BLOCK_INVALID"):
            self.derive(rows=[invalid])

    def test_replay_is_stable_and_never_transforms_misspelled_source_glyphs(self):
        x=self.derive(rows=[block("word","body","source typo")])
        y=self.derive(rows=[block("word","body","source typo")])
        self.assertEqual(x,y)
        self.assertEqual(x["scope_policy"]["misprinted_source_glyphs"],"PRESERVE_LITERAL")

if __name__=="__main__":
    unittest.main()
