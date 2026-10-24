#!/usr/bin/env python3
"""B15 private OCR order and ordinal-quarter diagnostics, never accuracy.

Only previously audited same-source OCR and markdown are read; neither is
ground truth. No provider, inference, weights, raw excerpts or coordinates.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import sys

from ebook_b15_disagreement_triage import (
    BOOK, PAGE, execute as audit_b15, REPORT as UPSTREAM_REPORT,
)
from ebook_fivebook_text_consensus import lexical, mineru_lexical_source
from ebook_fivebook_mineru_basic_matrix import file_names
from ebook_multibook_rapidocr_matrix import audit_existing as audit_rapidocr
from ebook_multibook_native_matrix import _private_folder
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b15_ordinal_quarters_and_order_gap.private.json"
EVIDENCE="B15_ORDER_VS_MULTISET_DISAGREEMENT_DIAGNOSIS_NOT_OCR_GOLD"
MAX_MD_BYTES=6_000_000
MAX_REPORT_BYTES=24000
MAX_CHARS=5000
MAX_CELLS=2_000_000
BANDS=("EMPTY","TOO_SHORT","ZERO","LOW","MEDIUM","HIGH")


def pair_order_metrics(rapid,mineru):
    """Exact LCS vs unordered character multiset, both non-GT diagnostics."""
    if not isinstance(rapid,str) or not isinstance(mineru,str):
        raise VisualGateError("B15_ORDER_TEXT_INVALID")
    n,m=len(rapid),len(mineru)
    if n>MAX_CHARS or m>MAX_CHARS or n*m>MAX_CELLS:
        raise VisualGateError("B15_ORDER_COMPUTATION_BUDGET_EXCEEDED")
    if not n or not m:
        return {"ordered_lcs_chars":0,"unordered_shared_characters":0,
                "unordered_minus_ordered_characters":0,
                "ordered_fraction_of_shorter_not_accuracy":None,
                "unordered_fraction_of_shorter_not_accuracy":None,
                "sequence_gap_fraction_of_shorter_not_accuracy":None}
    counts=Counter(rapid)&Counter(mineru)
    bag=sum(counts.values())
    prior=[0]*(m+1)
    for c in rapid:
        cur=[0]*(m+1)
        for j,d in enumerate(mineru,1):
            cur[j]=prior[j-1]+1 if c==d else max(prior[j],cur[j-1])
        prior=cur
    lcs=prior[m]
    if lcs>bag or bag>min(n,m):
        raise VisualGateError("B15_ORDER_METRIC_INVARIANT_FAILED")
    denom=min(n,m)
    return {"ordered_lcs_chars":lcs,
            "unordered_shared_characters":bag,
            "unordered_minus_ordered_characters":bag-lcs,
            "ordered_fraction_of_shorter_not_accuracy":round(lcs/denom,6),
            "unordered_fraction_of_shorter_not_accuracy":round(bag/denom,6),
            "sequence_gap_fraction_of_shorter_not_accuracy":
                round((bag-lcs)/denom,6)}


def ordinal_sections(upstream):
    lines=upstream.get("private_line_metadata_only")
    n=upstream.get("rapidocr_line_count")
    if (type(n) is not int or n<1 or n>300 or not isinstance(lines,list)
            or len(lines)!=n):
        raise VisualGateError("B15_ORDER_SOURCE_LINES_INVALID")
    result=[]
    for i,row in enumerate(lines):
        if (not isinstance(row,dict) or type(row.get("line_index")) is not int
                or row["line_index"]!=i
                or row.get("presence_band") not in BANDS
                or type(row.get("normalized_chars")) is not int
                or row["normalized_chars"]<0):
            raise VisualGateError("B15_ORDER_LINE_INVARIANT_FAILED")
    if sum(row["normalized_chars"] for row in lines)!=upstream.get("rapidocr_alnum_chars"):
        raise VisualGateError("B15_ORDER_LINE_CHAR_COUNT_CHANGED")
    for q in range(4):
        part=[row for row in lines if row["line_index"]*4//n==q]
        buckets={band:sum(row["presence_band"]==band for row in part)
                 for band in BANDS}
        result.append({"ordinal_quarter":q+1,"line_count":len(part),
                       "normalized_chars":sum(row["normalized_chars"] for row in part),
                       "zero_or_low_lines":buckets["ZERO"]+buckets["LOW"],
                       "short_or_empty_lines":buckets["TOO_SHORT"]+buckets["EMPTY"],
                       "presence_buckets":buckets})
    old_quarters=upstream.get("ordinal_quarters")
    if (not isinstance(old_quarters,list) or len(old_quarters)!=4 or any(
            old_quarters[i]!=dict(ordinal_quarter=i+1,
                line_count=result[i]["line_count"],
                normalized_chars=result[i]["normalized_chars"],
                low_or_zero_lines=result[i]["zero_or_low_lines"])
            for i in range(4))):
        raise VisualGateError("B15_ORDER_PREVIOUS_QUARTERS_CHANGED")
    expected=upstream.get("potential_line_support_buckets")
    if (not isinstance(expected,dict) or any(
            sum(q["presence_buckets"][band] for q in result)!=expected.get(band)
            for band in BANDS)):
        raise VisualGateError("B15_ORDER_PREVIOUS_BAND_COUNTS_CHANGED")
    # Ordinal ranges are based on OCR output order, NOT geometric page quadrants.
    return result


def compute(root,manifest):
    upstream=audit_b15(root,manifest,audit=True)
    if (upstream.get("book_id")!=BOOK or upstream.get("physical_page")!=PAGE
            or upstream.get("root_cause_verified") is not False
            or upstream.get("cer",object()) is not None
            or upstream.get("new_model_inferences")!=0):
        raise VisualGateError("B15_ORDER_UPSTREAM_NOT_RELIABLE")
    sections=ordinal_sections(upstream)
    rapid=audit_rapidocr(root,manifest)
    rows=[p for p in rapid.get("pages",[])
          if (p.get("book_id"),p.get("physical_page"))==(BOOK,PAGE)]
    if len(rows)!=1 or rows[0].get("private_rows_sha256")!=upstream.get(
            "rapid_private_rows_sha256"):
        raise VisualGateError("B15_ORDER_RAPID_SOURCE_IDENTITY_MISMATCH")
    strings=rows[0].get("rapidocr_private_rows")
    if (not isinstance(strings,list) or len(strings)!=upstream["rapidocr_line_count"]
            or any(not isinstance(x,dict) or not isinstance(x.get("text"),str)
                   for x in strings)):
        raise VisualGateError("B15_ORDER_RAPID_LINES_INVALID")
    r=lexical("\n".join(item["text"] for item in strings))
    folder=_private_folder(root)
    path=folder/file_names(BOOK)[1]
    if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=MAX_MD_BYTES:
        raise VisualGateError("B15_ORDER_MINERU_SOURCE_MISSING")
    raw=path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=upstream.get("mineru_private_markdown_sha256"):
        raise VisualGateError("B15_ORDER_MINERU_SHA_CHANGED")
    try:
        m=lexical(mineru_lexical_source(raw.decode("utf-8")))
    except UnicodeError:
        raise VisualGateError("B15_ORDER_MINERU_UTF8_INVALID") from None
    if (len(r)!=upstream.get("rapidocr_alnum_chars")
            or len(m)!=upstream.get("mineru_nonimage_alnum_chars")):
        raise VisualGateError("B15_ORDER_SOURCE_CHARACTER_COUNTS_CHANGED")
    return {"schema_version":1,"evidence":EVIDENCE,
            "book_id":BOOK,"physical_page":PAGE,
            "corpus_id":upstream["corpus_id"],
            "upstream_b15_receipt_sha256_private":hashlib.sha256(
                (folder/UPSTREAM_REPORT).read_bytes()).hexdigest(),
            "source_single_page_pdf_sha256_private":
                upstream["original_single_page_pdf_sha256_private"],
            "rapidocr_rows_sha256_private":upstream["rapid_private_rows_sha256"],
            "mineru_markdown_sha256_private":
                upstream["mineru_private_markdown_sha256"],
            "rapidocr_chars":len(r),"mineru_chars":len(m),
            "rapidocr_line_count":len(strings),
            "ordinal_quarters_not_geographic_regions":sections,
            **pair_order_metrics(r,m),
            "reference_truth":None,"cer":None,
            "ocr_quality_winner":None,"root_cause_verified":False,
            "provider_calls":0,"new_model_inferences":0,"model_downloads":0}


def execute(root,manifest,*,write=False,audit=False):
    folder=_private_folder(root)
    path=folder/REPORT
    if not audit and (path.exists() or path.is_symlink()):
        raise VisualGateError("B15_ORDER_REPORT_ALREADY_EXISTS")
    result=compute(root,manifest)
    blob=(json.dumps(result,sort_keys=True,separators=(",",":"),
                     ensure_ascii=False)+"\n").encode("utf-8")
    if len(blob)>MAX_REPORT_BYTES:
        raise VisualGateError("B15_ORDER_REPORT_TOO_LARGE")
    if audit:
        if path.is_symlink() or not path.is_file() or path.read_bytes()!=blob:
            raise VisualGateError("B15_ORDER_PRIVATE_RECEIPT_CHANGED")
    elif write:
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(path,flags,0o600),"wb") as out:
            out.write(blob)
    return result


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument("--write",action="store_true")
    mode.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    result=execute(Path(args.private_root),manifest,
                   write=args.write,audit=args.audit_only)
    print("ACS_B15_ORDER_STATUS="+(
        "PRIVATE_CREATED" if args.write else
        "RECEIPT_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_B15_ORDER_PAGE=109")
    print("ACS_B15_ORDER_RAPID_LINES="+str(result["rapidocr_line_count"]))
    for row in result["ordinal_quarters_not_geographic_regions"]:
        prefix="ACS_B15_ORDER_QUARTER_"+str(row["ordinal_quarter"])+"_"
        print(prefix+"LINES="+str(row["line_count"]))
        print(prefix+"LOW_OR_ZERO="+str(row["zero_or_low_lines"]))
        print(prefix+"SHORT_OR_EMPTY="+str(row["short_or_empty_lines"]))
    for key in ("ordered_lcs_chars","unordered_shared_characters",
                "unordered_minus_ordered_characters",
                "sequence_gap_fraction_of_shorter_not_accuracy"):
        print("ACS_B15_ORDER_"+key.upper()+"="+str(result[key]))
    print("ACS_B15_ORDER_GOLD=UNVERIFIED")
    print("ACS_B15_ORDER_ROOT_CAUSE=UNVERIFIED")
    print("ACS_B15_ORDER_NEW_MODEL_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,TypeError,OSError,RuntimeError):
        print("ACS_B15_ORDER_REJECTED=PRIVATE_PROVENANCE_OR_COMPUTATION_GATE")
        sys.exit(2)
