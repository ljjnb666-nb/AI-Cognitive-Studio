#!/usr/bin/env python3
"""Five-book real three-engine text agreement, source and SHA bound, no OCR calls.

Real same physical pages for RapidOCR standalone, MinerU Basic, and
Docling Standard+RapidOCR.  Only frozen D: OCR text is read.  Agreement is
NOT accuracy, CER, a quality winner, independent OCR majority, or OCR gold.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from ebook_fivebook_docling_standard_rapidocr_real import (
    execute as audit_standard_five, paths as standard_paths,
    valid_worker, read_bytes, REPORT as V7,
)
from ebook_fivebook_text_consensus import (
    execute as audit_original_consensus, lexical, mineru_lexical_source,
)
from ebook_fivebook_mineru_basic_matrix import ALL_BOOKS,file_names
from ebook_b31_mineru_basic_stateless import MARKDOWN as B31_MD
from ebook_multibook_rapidocr_matrix import audit_existing as audit_rapid
from ebook_b15_three_engine_consensus import (
    execute as audit_b15_three, numeric_pair, STANDARD_WORKER,
)
from ebook_multibook_native_matrix import _private_folder
from ebook_private_graph_receipt_audit import no_duplicate_keys,reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT="fivebook_three_engine_crossbook_consensus.v8.private.json"
EVIDENCE="FIVE_REAL_SAME_PAGE_THREE_ENGINE_AGREEMENT_NO_INDEPENDENT_OCR_GOLD"
ENGINES=("RAPIDOCR_STANDALONE","MINERU_BASIC","DOCLING_STANDARD_RAPIDOCR")
PAIR_INDICES=((0,1),(0,2),(1,2))
MAX_MD=6_000_000
MAX_WORKER=400_000
MAX_REPORT=40_000


def _json_private(raw):
    try:
        return json.loads(raw.decode("utf-8"),object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (ValueError,UnicodeError,TypeError):
        raise VisualGateError("FIVEBOOK_THREEWAY_PRIVATE_JSON_INVALID") from None


def compute(root,manifest,*,five_fn=audit_standard_five,
            original_fn=audit_original_consensus,
            rapid_fn=audit_rapid,b15_fn=audit_b15_three):
    root=Path(root)
    folder=_private_folder(root)
    five=five_fn(root,manifest,audit=True)
    original=original_fn(root,manifest,audit=True)
    b15=b15_fn(root,manifest,audit=True)
    rapid=rapid_fn(root,manifest)
    if (five.get("books")!=5 or five.get("same_source_focus_pages")!=5
            or five.get("all_five_real_standard_ocr_succeeded") is not True
            or five.get("actual_standard_ocr_success_pages")!=5
            or five.get("cer",object()) is not None
            or original.get("same_source_page_count")!=5
            or original.get("no_new_model_inference") is not True
            or original.get("corpus_id")!=b15.get("corpus_id")
            or five.get("cloud_calls")!=0 or five.get("model_downloads")!=0
            or b15.get("third_engine_actual_full_page_ocr_completed") is not True):
        raise VisualGateError("FIVEBOOK_THREEWAY_ORIGINAL_SOURCE_GATE")
    oldrows={x["book_id"]:x for x in original.get("rows",[])
             if isinstance(x,dict) and x.get("book_id") in ALL_BOOKS}
    newrows={x["book_id"]:x for x in five.get("rows",[])
             if isinstance(x,dict) and x.get("book_id") in ALL_BOOKS}
    rapids={x["book_id"]:x for x in rapid.get("pages",[])
             if isinstance(x,dict) and x.get("book_id") in ALL_BOOKS}
    if any(len(index)!=5 or set(index)!=set(ALL_BOOKS)
           for index in (oldrows,newrows,rapids)):
        raise VisualGateError("FIVEBOOK_THREEWAY_PAGE_COVERAGE_INVALID")
    rows=[]
    for book in ALL_BOOKS:
        old,new,rp=oldrows[book],newrows[book],rapids[book]
        if (old.get("physical_page")!=new.get("physical_page")
                or rp.get("physical_page")!=new.get("physical_page")
                or old.get("source_single_pdf_sha256_private")!=
                    new.get("source_page_sha256_private")
                or old.get("rapid_private_rows_sha256")!=
                    rp.get("private_rows_sha256")
                or new.get("status")!="REAL_STANDARD_PLUS_RAPIDOCR_SUCCESS"
                or old.get("mineru_nonimage_normalized_alnum_chars") is None
                or type(new.get("normalized_characters")) is not int):
            raise VisualGateError("FIVEBOOK_THREEWAY_SAME_PAGE_SHA_CHANGED")
        rlines=rp.get("rapidocr_private_rows")
        if (not isinstance(rlines,list) or any(
                not isinstance(x,dict) or not isinstance(x.get("text"),str)
                for x in rlines)):
            raise VisualGateError("FIVEBOOK_THREEWAY_RAPID_ROWS_INVALID")
        r=lexical("\n".join(x["text"] for x in rlines))
        mpath=folder/(B31_MD if book=="B31" else file_names(book)[1])
        md=read_bytes(mpath,MAX_MD)
        if hashlib.sha256(md).hexdigest()!=old.get("mineru_private_markdown_sha256"):
            raise VisualGateError("FIVEBOOK_THREEWAY_MINERU_MD_SHA_CHANGED")
        try:
            m=lexical(mineru_lexical_source(md.decode("utf-8")))
        except UnicodeError:
            raise VisualGateError("FIVEBOOK_THREEWAY_MINERU_UTF8_INVALID") from None
        wpath=(folder/STANDARD_WORKER if book=="B15" else
               standard_paths(folder,book)[1])
        blob=read_bytes(wpath,MAX_WORKER)
        item,norm=valid_worker(blob)
        std=lexical(mineru_lexical_source(item["private_markdown"]))
        if (norm!=len(std) or len(std)!=new["normalized_characters"]
                or len(r)!=old["rapidocr_normalized_alnum_chars"]
                or len(m)!=old["mineru_nonimage_normalized_alnum_chars"]):
            raise VisualGateError("FIVEBOOK_THREEWAY_FROZEN_LEXICAL_CHANGED")
        if book=="B15":
            earlier=b15.get("pairs",[])
            candidates=(r,m,std)
            for pair_idx,(i,j) in enumerate(PAIR_INDICES):
                measured=numeric_pair(ENGINES[i],ENGINES[j],candidates[i],candidates[j])
                if (pair_idx>=len(earlier) or
                        measured["symmetric_trigram_dice_not_accuracy"]!=
                        earlier[pair_idx]["symmetric_trigram_dice_not_accuracy"] or
                        measured["ordered_common_subsequence_characters"]!=
                        earlier[pair_idx]["ordered_common_subsequence_characters"]):
                    raise VisualGateError("FIVEBOOK_THREEWAY_B15_V5_CONFLICT")
        textviews=(r,m,std)
        pairs=[numeric_pair(ENGINES[i],ENGINES[j],textviews[i],textviews[j])
               for i,j in PAIR_INDICES]
        rows.append({
            "book_id":book,"physical_page":new["physical_page"],
            "same_original_single_page_sha256_private":
                new["source_page_sha256_private"],
            "rapidocr_rows_sha256_private":rp["private_rows_sha256"],
            "mineru_markdown_sha256_private":hashlib.sha256(md).hexdigest(),
            "standard_worker_sha256_private":hashlib.sha256(blob).hexdigest(),
            "normalized_characters":dict(zip(ENGINES,map(len,textviews))),
            "pairs":pairs,
            "standard_duration_ms":new["duration_ms"],
            "standard_text_items":new["text_item_count"],
            "standard_picture_items":new["picture_item_count"],
            "actual_real_standard_ocr":True,
        })
    if [x["book_id"] for x in rows]!=list(ALL_BOOKS):
        raise VisualGateError("FIVEBOOK_THREEWAY_ORDER_INVALID")
    return {
        "schema_version":8,"evidence":EVIDENCE,
        "corpus_id":original["corpus_id"],"same_original_page_count":5,
        "fivebook_standard_receipt_sha256_private":hashlib.sha256(
            read_bytes(folder/V7,MAX_REPORT)).hexdigest(),
        "rows":rows,
        "ocr_text_agreement_not_accuracy":True,
        "rapidocr_model_shared_between_two_paths":True,
        "independent_ocr_truth":None,"cer":None,
        "accuracy_winner":None,
        "new_ocr_calls":0,"cloud_calls":0,"model_downloads":0,
    }


def execute(root,manifest,*,write=False,audit=False,**kwargs):
    folder=_private_folder(root)
    output=folder/REPORT
    if not audit and (output.exists() or output.is_symlink()):
        raise VisualGateError("FIVEBOOK_THREEWAY_REPORT_ALREADY_EXISTS")
    data=compute(root,manifest,**kwargs)
    blob=(json.dumps(data,ensure_ascii=False,sort_keys=True,
                     separators=(",",":"))+"\n").encode("utf-8")
    if len(blob)>MAX_REPORT:
        raise VisualGateError("FIVEBOOK_THREEWAY_REPORT_EXCESSIVE")
    if audit:
        if output.is_symlink() or not output.is_file() or output.read_bytes()!=blob:
            raise VisualGateError("FIVEBOOK_THREEWAY_FROZEN_REPORT_CHANGED")
    elif write:
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(output,flags,0o600),"wb") as f:
            f.write(blob)
    return data


def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument("--private-root",required=True)
    p.add_argument("--manifest",required=True)
    flags=p.add_mutually_exclusive_group()
    flags.add_argument("--write",action="store_true")
    flags.add_argument("--audit-only",action="store_true")
    a=p.parse_args(argv)
    manifest=_json_private(Path(a.manifest).read_bytes())
    report=execute(Path(a.private_root),manifest,write=a.write,audit=a.audit_only)
    print("ACS_FIVEBOOK_THREEWAY_STATUS="+("PRIVATE_CREATED" if a.write else
        "PRIVATE_VERIFIED" if a.audit_only else "READONLY_READY"))
    print("ACS_FIVEBOOK_THREEWAY_SAME_PAGE_COUNT="+str(report["same_original_page_count"]))
    for row in report["rows"]:
        book=row["book_id"]
        for name,count in row["normalized_characters"].items():
            print("ACS_FIVEBOOK_THREEWAY_"+book+"_"+name+"_CHARS="+str(count))
        for pair in row["pairs"]:
            key="ACS_FIVEBOOK_THREEWAY_"+book+"_"+pair["first_engine"]+"_VS_"+pair["second_engine"]
            print(key+"_DICE_NOT_ACCURACY="+str(pair["symmetric_trigram_dice_not_accuracy"]))
            print(key+"_LCS="+str(pair["ordered_common_subsequence_characters"]))
    print("ACS_FIVEBOOK_THREEWAY_GOLD=UNVERIFIED")
    print("ACS_FIVEBOOK_THREEWAY_NEW_MODEL_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,UnicodeError,TypeError,OSError,RuntimeError):
        print("ACS_FIVEBOOK_THREEWAY_REJECTED=SOURCE_OR_LEXICAL_GATE")
        sys.exit(2)
