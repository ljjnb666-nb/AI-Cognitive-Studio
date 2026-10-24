#!/usr/bin/env python3
"""True same-B15-p109 three-engine TEXT agreement, never OCR accuracy.

Compares only previously frozen real private OCR outputs:
  independent RapidOCR, MinerU Basic, Docling Standard + RapidOCR.
No inference, no network, no raw phrases or boxes in public evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from ebook_b15_docling_standard_rapidocr_real import compute as audit_standard
from ebook_b15_order_sections import execute as audit_order, pair_order_metrics
from ebook_b15_spatial_disagreement import execute as audit_spatial
from ebook_multibook_rapidocr_matrix import audit_existing as audit_rapid
from ebook_fivebook_mineru_basic_matrix import file_names
from ebook_fivebook_text_consensus import lexical, mineru_lexical_source, agreement
from ebook_multibook_native_matrix import _private_folder
from ebook_private_graph_receipt_audit import no_duplicate_keys,reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b15_samepage_three_engine_consensus.v5.private.json"
STANDARD_WORKER="b15_docling_standard_rapidocr_worker.v4.private.json"
EVIDENCE="B15_PINNED_SAMEPAGE_THREE_ENGINE_AGREEMENT_NOT_OCR_GOLD"
MAX_MD=6_000_000
MAX_RECEIPT=35000
ENGINES=("RAPIDOCR_STANDALONE","MINERU_BASIC","DOCLING_STANDARD_RAPIDOCR")
PAIRS=((0,1),(0,2),(1,2))


def _source_file(path,max_size):
    if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=max_size:
        raise VisualGateError("B15_THREE_SOURCE_FILE_MISSING_OR_UNSAFE")
    return path.read_bytes()


def _decode_json(raw):
    try:
        return json.loads(raw.decode("utf-8"),object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (ValueError,TypeError,UnicodeError):
        raise VisualGateError("B15_THREE_PRIVATE_JSON_INVALID") from None


def numeric_pair(label_a,label_b,a,b):
    if label_a==label_b or not a or not b:
        raise VisualGateError("B15_THREE_PAIR_SOURCE_EMPTY")
    scores=agreement(a,b)
    ordering=pair_order_metrics(a,b)
    return {
        "first_engine":label_a,"second_engine":label_b,
        "first_lexical_characters":len(a),
        "second_lexical_characters":len(b),
        "common_trigrams":scores["shared_ngrams"],
        "first_trigrams":scores["rapidocr_ngrams"],
        "second_trigrams":scores["mineru_ngrams"],
        "first_trigram_overlap_fraction_not_accuracy":
            scores["rapidocr_ngrams_matched_fraction"],
        "second_trigram_overlap_fraction_not_accuracy":
            scores["mineru_ngrams_matched_fraction"],
        "symmetric_trigram_dice_not_accuracy":
            scores["symmetric_trigram_dice_not_accuracy"],
        "ordered_common_subsequence_characters":
            ordering["ordered_lcs_chars"],
        "unordered_common_multiset_characters":
            ordering["unordered_shared_characters"],
        "sequence_order_gap_not_accuracy":
            ordering["unordered_minus_ordered_characters"],
        "sequence_gap_fraction_not_accuracy":
            ordering["sequence_gap_fraction_of_shorter_not_accuracy"],
    }


def compute(root,manifest):
    folder=_private_folder(root)
    standard=audit_standard(root,manifest,audit=True)
    order=audit_order(root,manifest,audit=True)
    spatial=audit_spatial(root,manifest,audit=True)
    rapid=audit_rapid(root,manifest)
    if (standard.get("book_id")!="B15" or standard.get("physical_page")!=109
            or standard.get("status")!="REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS"
            or standard.get("actual_ocr_success") is not True
            or standard.get("cer",object()) is not None
            or standard.get("new_cloud_calls")!=0
            or standard.get("new_model_downloads")!=0
            or order.get("book_id")!="B15" or order.get("physical_page")!=109
            or spatial.get("book_id")!="B15" or spatial.get("physical_page")!=109
            or standard.get("corpus_id")!=order.get("corpus_id")
            or order.get("corpus_id")!=spatial.get("corpus_id")):
        raise VisualGateError("B15_THREE_UPSTREAM_IDENTITY_OR_GOLD_INVALID")
    matches=[x for x in rapid.get("pages",[])
             if (x.get("book_id"),x.get("physical_page"))==("B15",109)]
    if len(matches)!=1:
        raise VisualGateError("B15_THREE_RAPIDOCR_PAGE_NOT_UNIQUE")
    row=matches[0]
    if (row.get("source_document_sha256")!=spatial.get(
            "original_source_pdf_sha256_private")
            or row.get("private_rows_sha256")!=order.get(
                "rapid_private_rows_sha256")
            or row.get("rapidocr_line_count")!=order.get("rapidocr_line_count")):
        raise VisualGateError("B15_THREE_RAPIDOCR_SOURCE_CHANGED")
    lines=row.get("rapidocr_private_rows")
    if not isinstance(lines,list) or any(
            not isinstance(item,dict) or not isinstance(item.get("text"),str)
            for item in lines):
        raise VisualGateError("B15_THREE_RAPID_TEXT_INVALID")
    a=lexical("\n".join(item["text"] for item in lines))
    md_file=folder/file_names("B15")[1]
    md_bytes=_source_file(md_file,MAX_MD)
    if hashlib.sha256(md_bytes).hexdigest()!=order.get(
            "mineru_private_markdown_sha256"):
        raise VisualGateError("B15_THREE_MINERU_SOURCE_SHA_CHANGED")
    try:
        b=lexical(mineru_lexical_source(md_bytes.decode("utf-8")))
    except UnicodeError:
        raise VisualGateError("B15_THREE_MINERU_UTF8_INVALID") from None
    worker_bytes=_source_file(folder/STANDARD_WORKER,400000)
    if hashlib.sha256(worker_bytes).hexdigest()!=standard.get(
            "worker_sha256_private"):
        raise VisualGateError("B15_THREE_STANDARD_WORKER_SHA_CHANGED")
    worker=_decode_json(worker_bytes)
    if (not isinstance(worker,dict)
            or worker.get("pipeline")!="REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU"
            or worker.get("ocr_explicitly_enabled") is not True
            or not isinstance(worker.get("private_markdown"),str)):
        raise VisualGateError("B15_THREE_STANDARD_WORKER_NOT_OCR")
    c=lexical(mineru_lexical_source(worker["private_markdown"]))
    if (len(a)!=order.get("rapidocr_alnum_chars")
            or len(b)!=order.get("mineru_nonimage_alnum_chars")
            or len(c)!=standard.get("markdown_normalized_character_count")):
        raise VisualGateError("B15_THREE_NORMALIZED_COUNTS_CHANGED")
    views=(a,b,c)
    result={
        "schema_version":5,"evidence":EVIDENCE,
        "book_id":"B15","physical_page":109,
        "corpus_id":standard["corpus_id"],
        "private_standard_v4_sha256":hashlib.sha256(
            _source_file(folder/"b15_docling_standard_rapidocr_real.v4.private.json",
                         35000)).hexdigest(),
        "private_spatial_v3_sha256":hashlib.sha256(
            _source_file(folder/"b15_spatial_disagreement_heatmap_3x3.private.json",
                         35000)).hexdigest(),
        "private_mineru_markdown_sha256":hashlib.sha256(md_bytes).hexdigest(),
        "private_standalone_rapidocr_rows_sha256":row["private_rows_sha256"],
        "private_standard_worker_sha256":hashlib.sha256(worker_bytes).hexdigest(),
        "engines":[{"name":engine,"normalized_characters":len(views[i])}
                   for i,engine in enumerate(ENGINES)],
        "pairs":[numeric_pair(ENGINES[i],ENGINES[j],views[i],views[j])
                 for i,j in PAIRS],
        "source_same_original_book_and_physical_page":True,
        "third_engine_actual_full_page_ocr_completed":True,
        "text_similarity_not_accuracy":True,
        "independent_reference":None,"cer":None,"quality_winner":None,
        "new_ocr_calls":0,"new_cloud_calls":0,"model_downloads":0,
    }
    return result


def execute(root,manifest,*,write=False,audit=False):
    folder=_private_folder(root)
    target=folder/REPORT
    if not audit and (target.exists() or target.is_symlink()):
        raise VisualGateError("B15_THREE_REPORT_ALREADY_EXISTS")
    data=compute(root,manifest)
    raw=(json.dumps(data,ensure_ascii=False,
                    sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
    if len(raw)>MAX_RECEIPT:
        raise VisualGateError("B15_THREE_REPORT_TOO_LARGE")
    if audit:
        if target.is_symlink() or not target.is_file() or target.read_bytes()!=raw:
            raise VisualGateError("B15_THREE_REPORT_TAMPERED")
    elif write:
        flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(target,flags,0o600),"wb") as output:
            output.write(raw)
    return data


def main(argv=None):
    cli=argparse.ArgumentParser()
    cli.add_argument("--private-root",required=True)
    cli.add_argument("--manifest",required=True)
    opts=cli.add_mutually_exclusive_group()
    opts.add_argument("--write",action="store_true")
    opts.add_argument("--audit-only",action="store_true")
    args=cli.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    x=execute(Path(args.private_root),manifest,
              write=args.write,audit=args.audit_only)
    print("ACS_B15_THREE_STATUS="+(
        "PRIVATE_CREATED" if args.write else "PRIVATE_VERIFIED"
        if args.audit_only else "READONLY_READY"))
    for engine in x["engines"]:
        print("ACS_B15_THREE_"+engine["name"]+"_CHARS="+str(
            engine["normalized_characters"]))
    for pair in x["pairs"]:
        prefix="ACS_B15_THREE_"+pair["first_engine"]+"_VS_"+pair["second_engine"]+"_"
        print(prefix+"DICE_NOT_ACCURACY="+str(
            pair["symmetric_trigram_dice_not_accuracy"]))
        print(prefix+"LCS="+str(pair["ordered_common_subsequence_characters"]))
        print(prefix+"ORDER_GAP="+str(pair["sequence_order_gap_not_accuracy"]))
    print("ACS_B15_THREE_GOLD=UNVERIFIED")
    print("ACS_B15_THREE_NEW_OCR_CALLS=0")
    print("ACS_B15_THREE_PAID_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,UnicodeError,TypeError,RuntimeError,OSError):
        print("ACS_B15_THREE_REJECTED=PRIVATE_PROVENANCE_OR_AGREEMENT_GATE")
        sys.exit(2)
