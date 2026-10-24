#!/usr/bin/env python3
"""Private B15 same-source OCR disagreement diagnostics, NOT recognition quality.

Zero model calls. Audits existing five-book consensus first. Keeps all source
text, tokens and SHA exclusively in the Windows D: benchmark data directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from ebook_fivebook_text_consensus import (
    execute as audit_consensus, lexical, mineru_lexical_source, ngrams,
)
from ebook_multibook_rapidocr_matrix import audit_existing as audit_rapidocr
from ebook_fivebook_mineru_basic_matrix import file_names
from ebook_multibook_native_matrix import _private_folder
from ebook_private_glm_visual_reference import VisualGateError

BOOK="B15"
PAGE=109
REPORT="b15_samepage_ocr_disagreement_triage.private.json"
EVIDENCE="B15_PRIVATE_LINE_SUPPORT_DIAGNOSTICS_NOT_ACCURACY"
MAX_MARKDOWN=6_000_000
MAX_REPORT=40_000


def line_support(lines,mineru):
    """Trigrams present in other output, NOT word/character correctness.

    Per-line scores are *potential* multiset overlap. A shared repeated
    phrase on separate lines can be counted again: never sum these scores
    to claim global recall or accuracy.
    """
    other=ngrams(mineru)
    rows=[]
    for ordinal,raw in enumerate(lines):
        text=lexical(raw)
        gram=ngrams(text) if len(text)>=3 else {}
        count=sum(gram.values())
        hits=sum(min(n,other.get(k,0)) for k,n in gram.items())
        coverage=round(hits/count,6) if count else None
        band=("EMPTY" if not text else "TOO_SHORT" if not count else
              "ZERO" if hits==0 else "LOW" if hits*2<count else
              "MEDIUM" if hits*10<count*9 else "HIGH")
        rows.append({"line_index":ordinal,"normalized_chars":len(text),
                     "trigrams":count,"potential_shared_trigrams":hits,
                     "potential_presence_fraction_not_accuracy":coverage,
                     "presence_band":band})
    return rows


def compute(root,manifest):
    baseline=audit_consensus(root,manifest,audit=True)
    rapid=audit_rapidocr(root,manifest)
    if (baseline.get("same_source_page_count")!=5 or
            baseline.get("agreement_is_not_accuracy") is not True or
            baseline.get("cer",object()) is not None or
            rapid.get("ocr_pages")!=5 or
            baseline.get("corpus_id")!=rapid.get("corpus_id")):
        raise VisualGateError("B15_UPSTREAM_CONSENSUS_INVALID")
    b=[r for r in baseline["rows"]
       if (r.get("book_id"),r.get("physical_page"))==(BOOK,PAGE)]
    p=[r for r in rapid["pages"]
       if (r.get("book_id"),r.get("physical_page"))==(BOOK,PAGE)]
    if len(b)!=1 or len(p)!=1:
        raise VisualGateError("B15_SOURCE_PAGE_IDENTITY_INVALID")
    source,record=b[0],p[0]
    if (source.get("rapid_private_rows_sha256")!=record.get("private_rows_sha256") or
            source.get("same_sha_pinned_original_page") is not True or
            not isinstance(record.get("rapidocr_private_rows"),list)):
        raise VisualGateError("B15_PRIVATE_RAPID_RECEIPT_CHANGED")
    folder=_private_folder(root)
    md_path=folder/file_names(BOOK)[1]
    if (md_path.is_symlink() or not md_path.is_file() or
            not 0<md_path.stat().st_size<=MAX_MARKDOWN):
        raise VisualGateError("B15_PRIVATE_MINERU_MARKDOWN_MISSING")
    raw=md_path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=source.get("mineru_private_markdown_sha256"):
        raise VisualGateError("B15_PRIVATE_MARKDOWN_SHA_CHANGED")
    try:
        markdown=raw.decode("utf-8")
    except UnicodeError:
        raise VisualGateError("B15_PRIVATE_MARKDOWN_DECODE_INVALID") from None
    lines=record["rapidocr_private_rows"]
    if not lines or any(not isinstance(x,dict) or
                        not isinstance(x.get("text"),str) for x in lines):
        raise VisualGateError("B15_PRIVATE_OCR_LINES_INVALID")
    strings=[x["text"] for x in lines]
    rapid_text=lexical("\n".join(strings))
    mineru_text=lexical(mineru_lexical_source(markdown))
    if (len(rapid_text)!=source.get("rapidocr_normalized_alnum_chars") or
            len(mineru_text)!=source.get("mineru_nonimage_normalized_alnum_chars") or
            sum(len(lexical(s)) for s in strings)!=len(rapid_text)):
        raise VisualGateError("B15_PRIOR_NORMALIZATION_CHANGED")
    detailed=line_support(strings,mineru_text)
    buckets={name:sum(x["presence_band"]==name for x in detailed)
             for name in ("EMPTY","TOO_SHORT","ZERO","LOW","MEDIUM","HIGH")}
    # Four position groups count all rows; they diagnose concentration,
    # not page spatial geometry or which OCR model is correct.
    quarters=[]
    for k in range(4):
        selection=[x for x in detailed
                   if x["line_index"]*4//len(detailed)==k]
        quarters.append({
            "ordinal_quarter":k+1,"line_count":len(selection),
            "normalized_chars":sum(x["normalized_chars"] for x in selection),
            "low_or_zero_lines":sum(x["presence_band"] in ("LOW","ZERO")
                                    for x in selection),
        })
    return {
        "schema_version":1,"evidence":EVIDENCE,"book_id":BOOK,
        "physical_page":PAGE,"corpus_id":baseline["corpus_id"],
        "original_single_page_pdf_sha256_private":
            source["source_single_pdf_sha256_private"],
        "rapid_private_rows_sha256":source["rapid_private_rows_sha256"],
        "mineru_private_markdown_sha256":
            source["mineru_private_markdown_sha256"],
        "rapidocr_alnum_chars":len(rapid_text),
        "mineru_nonimage_alnum_chars":len(mineru_text),
        "source_character_length_difference":len(rapid_text)-len(mineru_text),
        "mineru_to_rapid_length_ratio_not_accuracy":
            round(len(mineru_text)/len(rapid_text),6) if rapid_text else None,
        "global_trigram_dice_not_accuracy":
            source["symmetric_trigram_dice_not_accuracy"],
        "rapidocr_line_count":len(detailed),
        "potential_line_support_buckets":buckets,
        "ordinal_quarters":quarters,
        "private_line_metadata_only":detailed,
        "line_presence_is_not_coverage_gold":True,
        "root_cause_verified":False,
        "ocr_ground_truth":None,"cer":None,"graph_f1":None,"table_f1":None,
        "provider_calls":0,"new_model_inferences":0,"model_downloads":0,
    }


def execute(root,manifest,*,write=False,audit=False):
    folder=_private_folder(root)
    output=folder/REPORT
    if not audit and (output.exists() or output.is_symlink()):
        raise VisualGateError("B15_REPORT_ALREADY_EXISTS")
    data=compute(root,manifest)
    blob=(json.dumps(data,sort_keys=True,ensure_ascii=False,
                     separators=(",",":"))+"\n").encode("utf-8")
    if len(blob)>MAX_REPORT:
        raise VisualGateError("B15_PRIVATE_REPORT_TOO_LARGE")
    if audit:
        if (output.is_symlink() or not output.is_file() or
                output.read_bytes()!=blob):
            raise VisualGateError("B15_FROZEN_REPORT_CHANGED")
    elif write:
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(output,flags,0o600),"wb") as f:
            f.write(blob)
    return data


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    group=parser.add_mutually_exclusive_group()
    group.add_argument("--write",action="store_true")
    group.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    result=execute(Path(args.private_root),manifest,write=args.write,
                   audit=args.audit_only)
    print("ACS_B15_TRIAGE_STATUS="+(
        "PRIVATE_CREATED" if args.write else
        "PRIVATE_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_B15_TRIAGE_PAGE=109")
    print("ACS_B15_TRIAGE_LINE_COUNT="+str(result["rapidocr_line_count"]))
    for key,value in result["potential_line_support_buckets"].items():
        print("ACS_B15_TRIAGE_"+key+"_LINES="+str(value))
    print("ACS_B15_TRIAGE_ROOT_CAUSE=UNVERIFIED")
    print("ACS_B15_TRIAGE_OCR_ACCURACY=UNVERIFIED")
    print("ACS_B15_TRIAGE_NEW_MODEL_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,TypeError,OSError,RuntimeError):
        print("ACS_B15_TRIAGE_REJECTED=PRIVATE_SOURCE_OR_RECEIPT_GATE")
        sys.exit(2)
