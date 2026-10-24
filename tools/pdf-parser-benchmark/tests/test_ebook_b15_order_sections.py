"""B15 ordinal support and exact ordered-vs-unordered character diagnostics."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from contextlib import ExitStack

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import ebook_b15_order_sections as subject
from ebook_private_glm_visual_reference import VisualGateError


def fixture(root):
    folder=root/"semantic_gate"/"multibook_matrix_20261023"
    folder.mkdir(parents=True)
    texts=["abc","def","","Z","ghi","jk","lmn","opq"]
    bands=["HIGH","ZERO","EMPTY","TOO_SHORT","LOW","TOO_SHORT","MEDIUM","HIGH"]
    lines=[{"line_index":i,"normalized_chars":len(s),"presence_band":bands[i]}
           for i,s in enumerate(texts)]
    buckets={band:bands.count(band) for band in subject.BANDS}
    quarters=[]
    for q in range(4):
        subset=lines[2*q:2*q+2]
        quarters.append({
            "ordinal_quarter":q+1,"line_count":2,
            "normalized_chars":sum(x["normalized_chars"] for x in subset),
            "low_or_zero_lines":sum(x["presence_band"] in ("ZERO","LOW")
                                    for x in subset),
        })
    upstream={
        "book_id":"B15","physical_page":109,"corpus_id":"PRIVATE_FIXTURE",
        "root_cause_verified":False,"cer":None,"new_model_inferences":0,
        "rapidocr_line_count":len(texts),
        "rapidocr_alnum_chars":sum(len(s) for s in texts),
        "mineru_nonimage_alnum_chars":6,
        "private_line_metadata_only":lines,
        "potential_line_support_buckets":buckets,
        "ordinal_quarters":quarters,
        "rapid_private_rows_sha256":"a"*64,
        "original_single_page_pdf_sha256_private":"b"*64,
    }
    markdown="## abcghi\n![hidden](data:image/png;base64,"+"QUJD"*3000+")"
    source=folder/subject.file_names("B15")[1]
    source.write_text(markdown,encoding="utf-8")
    upstream["mineru_private_markdown_sha256"]=hashlib.sha256(
        markdown.encode("utf-8")).hexdigest()
    (folder/subject.UPSTREAM_REPORT).write_text("PRIVATE-PRIOR-RECEIPT",
                                               encoding="utf-8")
    rapid={"pages":[{"book_id":"B15","physical_page":109,
                     "private_rows_sha256":"a"*64,
                     "rapidocr_private_rows":[{"text":s} for s in texts]}]}
    return folder,source,upstream,rapid


class B15SectionsTests(unittest.TestCase):
    def sources(self,folder,upstream,rapid):
        stack=ExitStack()
        stack.enter_context(patch.object(subject,"audit_b15",return_value=upstream))
        stack.enter_context(patch.object(subject,"audit_rapidocr",return_value=rapid))
        stack.enter_context(patch.object(subject,"_private_folder",return_value=folder))
        return stack

    def test_order_sensitive_gap_distinguishes_reordering_without_truth(self):
        result=subject.pair_order_metrics("abcd","dcba")
        self.assertEqual(result["unordered_shared_characters"],4)
        self.assertEqual(result["ordered_lcs_chars"],1)
        self.assertEqual(result["unordered_minus_ordered_characters"],3)
        self.assertEqual(result["sequence_gap_fraction_of_shorter_not_accuracy"],.75)
        self.assertEqual(subject.pair_order_metrics("abcd","abcd")[
            "sequence_gap_fraction_of_shorter_not_accuracy"],0)
        self.assertEqual(subject.pair_order_metrics("abcd","wxyz")[
            "unordered_shared_characters"],0)

    def test_empty_and_bounded_fail_closed(self):
        self.assertIsNone(subject.pair_order_metrics("","")[
            "ordered_fraction_of_shorter_not_accuracy"])
        self.assertIsNone(subject.pair_order_metrics("abc","")[
            "unordered_fraction_of_shorter_not_accuracy"])
        with self.assertRaisesRegex(VisualGateError,"BUDGET_EXCEEDED"):
            subject.pair_order_metrics("a"*2000,"b"*2000)

    def test_quarters_and_frozen_report_preserve_history_and_privacy(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t); folder,md,upstream,rapid=fixture(root)
            with self.sources(folder,upstream,rapid):
                got=subject.execute(root,{},write=True)
                self.assertEqual(got["rapidocr_line_count"],8)
                self.assertEqual([x["zero_or_low_lines"] for x in
                    got["ordinal_quarters_not_geographic_regions"]],[1,0,1,0])
                self.assertEqual([x["line_count"] for x in
                    got["ordinal_quarters_not_geographic_regions"]],[2,2,2,2])
                self.assertEqual(got["ordered_lcs_chars"],6)
                self.assertEqual(got["unordered_shared_characters"],6)
                self.assertFalse(got["root_cause_verified"])
                self.assertIsNone(got["cer"])
                saved=(folder/subject.REPORT).read_text("utf-8")
                for text in ("abcghi","QUJD","PRIVATE-PRIOR-RECEIPT",
                             "hidden","recognition truth"):
                    self.assertNotIn(text,saved)
                self.assertEqual(subject.execute(root,{},audit=True),got)
                with self.assertRaisesRegex(VisualGateError,"ALREADY_EXISTS"):
                    subject.execute(root,{},write=True)

    def test_tampered_upstream_quarter_and_source_sha_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);folder,md,upstream,rapid=fixture(root)
            with self.sources(folder,upstream,rapid):
                upstream["ordinal_quarters"][0]["low_or_zero_lines"]=9
                with self.assertRaisesRegex(VisualGateError,"PREVIOUS_QUARTERS_CHANGED"):
                    subject.execute(root,{},write=True)
                upstream["ordinal_quarters"][0]["low_or_zero_lines"]=1
                md.write_text("wrong",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"MINERU_SHA_CHANGED"):
                    subject.execute(root,{},write=True)
                self.assertFalse((folder/subject.REPORT).exists())

    def test_report_tamper_detected_on_independent_reaudit(self):
        with tempfile.TemporaryDirectory() as t:
            root=Path(t);folder,md,upstream,rapid=fixture(root)
            with self.sources(folder,upstream,rapid):
                subject.execute(root,{},write=True)
                report=folder/subject.REPORT
                report.write_text("{}",encoding="utf-8")
                with self.assertRaisesRegex(VisualGateError,"PRIVATE_RECEIPT_CHANGED"):
                    subject.execute(root,{},audit=True)


if __name__=="__main__":
    unittest.main()
