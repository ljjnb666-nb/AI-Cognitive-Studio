#!/usr/bin/env python3
"""Five-book RapidOCR/MinerU text agreement, NOT OCR accuracy or CER.

All original text stays on D:; only per-book aggregate numerical metrics
and private source hashes appear in the receipt. No inference/API calls.
"""
import argparse
from collections import Counter
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sys
import unicodedata

from ebook_fivebook_mineru_basic_matrix import combined, ALL_BOOKS, file_names
from ebook_multibook_rapidocr_matrix import audit_existing as audit_rapidocr
from ebook_b31_mineru_basic_stateless import MARKDOWN as B31_MD
from ebook_b31_mineru_markdown_structure import (
    DATA_URI,MD_IMAGE,HTML_IMAGE,HTML_TAG,LINK_LABEL,count_structure
)
from ebook_multibook_native_matrix import _private_folder
from ebook_private_graph_receipt_audit import no_duplicate_keys,reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT="fivebook_rapidocr_mineru_text_consensus.private.json"
EVIDENCE="SAME_FIVE_PDF_FOCUS_PAGES_MODEL_AGREEMENT_NOT_OCR_GOLD"
MAX_MD_BYTES=6_000_000
MAX_LEXICAL=20_000
MAX_REPORT=80_000
IMAGE_REF=re.compile(r"!\[[^\]\n]{0,1000}\]\[[^\]\n]{0,1000}\]")
HEADING=re.compile(r"(?m)^[ \t]{0,6}(?:#{1,6}[ \t]+|[-*+][ \t]+|[0-9]{1,4}\.[ \t]+)")
LINK_DEF=re.compile(r"(?m)^[ \t]{0,4}\[[^\]\n]{1,256}\]:[^\n]{1,2500}$")
HTML_COMMENT=re.compile(r"(?s)<!--.{0,2500}?-->")
FENCE=re.compile(r"(?m)^[ \t]*(?:\x60{3,}|~{3,})[^\n]*$")
ZERO_WIDTH={"\u200b","\u200c","\u200d","\ufeff"}


def lexical(text):
    if not isinstance(text,str) or len(text)>MAX_MD_BYTES:
        raise VisualGateError("CONSENSUS_LEXICAL_SOURCE_TOO_LARGE")
    text=unicodedata.normalize("NFKC",html.unescape(text))
    result=[]
    for char in text:
        if char not in ZERO_WIDTH and char.isalnum():
            result.append(char.casefold())
        if len(result)>MAX_LEXICAL:
            raise VisualGateError("CONSENSUS_NORMALIZED_TEXT_TOO_LONG")
    return "".join(result)


def mineru_lexical_source(markdown):
    if not isinstance(markdown,str) or len(markdown)>MAX_MD_BYTES:
        raise VisualGateError("CONSENSUS_MARKDOWN_TOO_LARGE")
    # Critical: remove base64 FIRST; then remove enclosing image markup.
    text=DATA_URI.sub(" ",markdown)
    text=MD_IMAGE.sub(" ",text)
    text=IMAGE_REF.sub(" ",text)
    text=HTML_IMAGE.sub(" ",text)
    text=HTML_COMMENT.sub(" ",text)
    text=LINK_DEF.sub(" ",text)
    text=HTML_TAG.sub(" ",text)
    text=LINK_LABEL.sub(lambda match:match.group(1),text)
    text=FENCE.sub(" ",text)
    return HEADING.sub(" ",text)


def ngrams(text):
    if not text:
        return Counter()
    width=min(3,len(text))
    return Counter(text[i:i+width] for i in range(len(text)-width+1))


def agreement(rapid,mineru):
    a,b=ngrams(rapid),ngrams(mineru)
    na,nb=sum(a.values()),sum(b.values())
    same=sum(min(n,b[token]) for token,n in a.items())
    return {
        "rapidocr_ngrams":na,"mineru_ngrams":nb,
        "shared_ngrams":same,
        "rapidocr_ngrams_matched_fraction":round(same/na,6) if na else None,
        "mineru_ngrams_matched_fraction":round(same/nb,6) if nb else None,
        "symmetric_trigram_dice_not_accuracy":(
            round(2*same/(na+nb),6) if na+nb else None),
        "both_nonempty":bool(rapid) and bool(mineru),
        "agreement_not_correctness":True,
    }


def compute(root,manifest):
    matrix=combined(root,manifest,audit=True)
    rapid=audit_rapidocr(root,manifest)
    if (matrix.get("identical_focus_pages")!=5 or
            matrix.get("new_mineru_inferences")!=4 or
            matrix.get("b31_mineru_result_reused") is not True or
            rapid.get("ocr_books")!=5 or rapid.get("ocr_pages")!=5):
        raise VisualGateError("CONSENSUS_PREVIOUS_BENCHMARK_INCOMPLETE")
    rapidindex={(p["book_id"],p["physical_page"]):p for p in rapid["pages"]}
    if len(rapidindex)!=5:
        raise VisualGateError("CONSENSUS_RAPID_PAGE_SET_INVALID")
    folder=_private_folder(root)
    rows=[]
    for prior in matrix["rows"]:
        book,page=prior["book_id"],prior["physical_page"]
        if book not in ALL_BOOKS or (book,page) not in rapidindex:
            raise VisualGateError("CONSENSUS_PHYSICAL_PAGE_MISMATCH")
        rp=rapidindex[(book,page)]
        if (rp["rapidocr_line_count"]!=prior["rapidocr_lines"] or
                rp["rapidocr_char_count"]!=prior["rapidocr_characters"] or
                rp["duration_ms"]!=prior["rapidocr_duration_ms"]):
            raise VisualGateError("CONSENSUS_RAPID_PROVENANCE_CHANGED")
        source=folder/(B31_MD if book=="B31" else file_names(book)[1])
        if (source.is_symlink() or not source.is_file() or
                not 0<source.stat().st_size<=MAX_MD_BYTES):
            raise VisualGateError("CONSENSUS_MINERU_SOURCE_MISSING")
        try:
            md=source.read_text("utf-8")
        except UnicodeError:
            raise VisualGateError("CONSENSUS_MINERU_INVALID_UTF8") from None
        counts=count_structure(md)
        if (counts["markdown_raw_character_count"]!=prior["mineru_markdown_raw_chars"] or
                counts["embedded_image_data_uri_count"]!=prior["mineru_image_data_uri_count"] or
                counts["embedded_image_data_uri_raw_characters"]!=prior["mineru_base64_image_payload_chars"] or
                counts["nonwhitespace_nonimage_markdown_residue_chars"]!=prior["mineru_nonimage_nonwhitespace_residue"]):
            raise VisualGateError("CONSENSUS_MINERU_PRIOR_COUNTS_CHANGED")
        extracted=rp["rapidocr_private_rows"]
        if (not isinstance(extracted,list) or
                any(not isinstance(e,dict) or not isinstance(e.get("text"),str)
                    for e in extracted) or
                sum(len(e["text"]) for e in extracted)!=prior["rapidocr_characters"]):
            raise VisualGateError("CONSENSUS_RAPID_TEXT_INVALID")
        rview=lexical("\n".join(e["text"] for e in extracted))
        mview=lexical(mineru_lexical_source(md))
        rows.append({
            "book_id":book,"physical_page":page,
            "same_sha_pinned_original_page":True,
            "rapid_private_rows_sha256":rp["private_rows_sha256"],
            "mineru_private_markdown_sha256":hashlib.sha256(md.encode("utf-8")).hexdigest(),
            "source_single_pdf_sha256_private":prior["source_pdf_sha256_private"],
            "rapidocr_normalized_alnum_chars":len(rview),
            "mineru_nonimage_normalized_alnum_chars":len(mview),
            "mineru_base64_image_chars":counts["embedded_image_data_uri_raw_characters"],
            **agreement(rview,mview),
            "normalization":"NFKC_CASEFOLD_ALNUM_NOT_OCR_TRUTH",
            "independent_reference":None,
        })
    if len(rows)!=5 or [p["book_id"] for p in rows]!=list(ALL_BOOKS):
        raise VisualGateError("CONSENSUS_COVERAGE_OR_ORDER_INVALID")
    return {
        "schema_version":1,"evidence":EVIDENCE,
        "corpus_id":matrix["corpus_id"],"same_source_page_count":5,
        "no_new_model_inference":True,"model_downloads":0,"paid_provider_calls":0,
        "ocr_ground_truth":None,"cer":None,"table_f1":None,
        "formula_f1":None,"graph_f1":None,
        "agreement_is_not_accuracy":True,"rows":rows,
    }


def execute(root,manifest,*,write=False,audit=False):
    folder=_private_folder(root)
    output=folder/REPORT
    if not audit and (output.exists() or output.is_symlink()):
        raise VisualGateError("CONSENSUS_REPORT_ALREADY_EXISTS")
    result=compute(root,manifest)
    blob=(json.dumps(result,ensure_ascii=False,sort_keys=True,
                     separators=(",",":"))+"\n").encode("utf-8")
    if len(blob)>MAX_REPORT:
        raise VisualGateError("CONSENSUS_REPORT_TOO_LARGE")
    if audit:
        if output.is_symlink() or not output.is_file() or output.read_bytes()!=blob:
            raise VisualGateError("CONSENSUS_PRIVATE_REPORT_TAMPERED")
    elif write:
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(output,flags,0o600),"wb") as handle:
            handle.write(blob)
    return result


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    group=parser.add_mutually_exclusive_group()
    group.add_argument("--write",action="store_true")
    group.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    result=execute(Path(args.private_root),manifest,
                   write=args.write,audit=args.audit_only)
    print("ACS_TEXT_CONSENSUS_STATUS="+(
        "PRIVATE_CREATED" if args.write else
        "RECEIPT_VERIFIED" if args.audit_only else "READONLY_READY"))
    for row in result["rows"]:
        name="ACS_TEXT_CONSENSUS_"+row["book_id"]
        print(name+"_PAGE="+str(row["physical_page"]))
        print(name+"_RAPID_ALNUM="+str(row["rapidocr_normalized_alnum_chars"]))
        print(name+"_MINERU_ALNUM="+str(row["mineru_nonimage_normalized_alnum_chars"]))
        print(name+"_TRIGRAM_DICE_NOT_ACCURACY="+str(
            row["symmetric_trigram_dice_not_accuracy"]))
    print("ACS_TEXT_CONSENSUS_REFERENCE_CER=UNVERIFIED")
    print("ACS_TEXT_CONSENSUS_NEW_MODEL_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,TypeError,OSError,RuntimeError):
        print("ACS_TEXT_CONSENSUS_REJECTED=PRIVATE_SOURCE_OR_RECEIPT_GATE")
        sys.exit(2)
