#!/usr/bin/env python3
"""Source-PNG-bound, *conditionally approved* OCR error metrics for 3 engines.

Reads existing frozen D: sources only. No transcription, OCR, LLM, gold
approval, downloads, or cloud calls. No raw text in receipts/public logs.

The normalized alphanumeric character error rate (CER) intentionally strips
punctuation, images and layout; it is NOT a full fidelity, figure or
punctuation accuracy metric.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from ebook_fivebook_reference_gate import (
    compute as reference_compute, admit_reference, edit_distance, private_load,
    snapshot_names, MAX_NORMALIZED, SHA,
)
from ebook_fivebook_three_engine_crossbook import (
    execute as threeway_execute, ENGINES, STANDARD_WORKER, MAX_MD, MAX_WORKER,
)
from ebook_multibook_native_matrix import audit_existing as native_audit, _private_folder, MAX_PNG, TARGETS as NATIVE_BOOKS
from ebook_multibook_rapidocr_matrix import audit_existing as rapid_audit
from ebook_fivebook_mineru_basic_matrix import ALL_BOOKS, file_names
from ebook_fivebook_text_consensus import lexical, mineru_lexical_source
from ebook_b31_mineru_basic_stateless import MARKDOWN as B31_MD
from ebook_fivebook_docling_standard_rapidocr_real import paths as worker_paths, read_bytes, valid_worker
from ebook_private_graph_receipt_audit import no_duplicate_keys, reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT="fivebook_three_engine_verified_gold_grade"
MAX_REPORT=24_000
EVIDENCE="THREE_ENGINE_CER_ONLY_IF_INDEPENDENT_FULL_PAGE_GOLD_AND_SOURCE_PNG_ATTESTED"
SHA_LENGTH=64


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def source_png(folder,native,book,page):
    rows=[x for x in native.get("rows",[]) if x.get("book_id")==book]
    if len(rows)!=1:
        raise VisualGateError("GOLD_GRADE_SOURCE_BOOK_UNTRUSTED")
    pages=[x for x in rows[0].get("pages",[]) if x.get("physical_page")==page]
    if len(pages)!=1:
        raise VisualGateError("GOLD_GRADE_SOURCE_PAGE_UNTRUSTED")
    meta=pages[0]
    expected=f"{book}_p{page:04d}.private.png"
    if meta.get("ocr_focus_png")!=expected:
        raise VisualGateError("GOLD_GRADE_SOURCE_IMAGE_NAME_CHANGED")
    raw=read_bytes(folder/expected,MAX_PNG)
    actual=digest(raw)
    if actual!=meta.get("ocr_focus_png_sha256"):
        raise VisualGateError("GOLD_GRADE_SOURCE_IMAGE_SHA_CHANGED")
    return actual


def score_alnum_only(ref, predictions):
    if (not isinstance(ref,str) or not 0<len(ref)<=MAX_NORMALIZED or
            set(predictions)!=set(ENGINES) or
            any(not isinstance(x,str) or len(x)>MAX_NORMALIZED
                for x in predictions.values())):
        raise VisualGateError("GOLD_GRADE_SCORE_INPUT_INVALID")
    return {engine:round(edit_distance(ref,predictions[engine])/len(ref),6)
            for engine in ENGINES}


def validated_parent_receipts(gold, three, native, rapid):
    """Require one exact, mutually source-bound record per physical focus page.

    Parent auditors protect their own receipts; this closes the *cross-parent*
    join so extra/duplicate rows cannot vanish in a dictionary comprehension,
    and a matching book/page with a different original PDF is never scored.
    Applies even while all independent references are missing.
    """
    expected=set(ALL_BOOKS)

    def index(rows, allowed):
        if not isinstance(rows,list) or len(rows)!=len(allowed):
            raise VisualGateError("GOLD_GRADE_PARENT_ROW_COVERAGE_INVALID")
        out={}
        for row in rows:
            if not isinstance(row,dict):
                raise VisualGateError("GOLD_GRADE_PARENT_ROW_COVERAGE_INVALID")
            key=row.get("book_id")
            if key not in allowed or key in out:
                raise VisualGateError("GOLD_GRADE_PARENT_ROW_COVERAGE_INVALID")
            out[key]=row
        if set(out)!=allowed:
            raise VisualGateError("GOLD_GRADE_PARENT_ROW_COVERAGE_INVALID")
        return out

    if (not isinstance(gold.get("corpus_id"),str) or
            not gold["corpus_id"] or
            rapid.get("corpus_id")!=gold["corpus_id"]):
        raise VisualGateError("GOLD_GRADE_PARENT_CORPUS_CHANGED")
    refs=index(gold.get("rows"),expected)
    models=index(three.get("rows"),expected)
    rapids=index(rapid.get("pages"),expected)
    natives=index(native.get("rows"),set(NATIVE_BOOKS))
    for book in ALL_BOOKS:
        ref,model,rapidrow,nativebook=(refs[book],models[book],
                                       rapids[book],natives[book])
        page=ref.get("physical_page")
        original=nativebook.get("source_document_sha256")
        if (type(page) is not int or page<1 or
                not isinstance(original,str) or SHA.fullmatch(original) is None or
                ref.get("original_pdf_source_sha256_private")!=original or
                model.get("same_original_single_page_sha256_private")!=original or
                rapidrow.get("source_document_sha256")!=original or
                model.get("physical_page")!=page or
                rapidrow.get("physical_page")!=page or
                model.get("rapidocr_rows_sha256_private")!=rapidrow.get("private_rows_sha256")):
            raise VisualGateError("GOLD_GRADE_CROSS_PARENT_SOURCE_CHANGED")
        pages=nativebook.get("pages")
        matches=([p for p in pages if isinstance(p,dict) and
                  p.get("physical_page")==page]
                 if isinstance(pages,list) else [])
        if (len(matches)!=1 or
                rapidrow.get("render_png_sha256")!=matches[0].get("ocr_focus_png_sha256")):
            raise VisualGateError("GOLD_GRADE_CROSS_PARENT_IMAGE_CHANGED")
    return refs,models,rapids


def compute(root,manifest,*,snapshot_version=1,
            reference_fn=reference_compute,three_fn=threeway_execute,
            native_fn=native_audit,rapid_fn=rapid_audit):
    root=Path(root)
    folder=_private_folder(root)
    gold=reference_fn(root,manifest,snapshot_version=snapshot_version)
    three=three_fn(root,manifest,audit=True)
    native=native_fn(root,manifest)
    rapid=rapid_fn(root,manifest)
    if (gold.get("page_count")!=5 or
            gold.get("reference_provenance_truth_requires_external_audit") is not True or
            three.get("same_original_page_count")!=5 or
            native.get("ocr_focus_image_count")!=5 or
            three.get("corpus_id")!=gold.get("corpus_id") or
            native.get("corpus_id")!=gold.get("corpus_id")):
        raise VisualGateError("GOLD_GRADE_FIVEBOOK_PARENT_RECEIPTS_INVALID")
    refs,three_rows,rapids=validated_parent_receipts(gold,three,native,rapid)
    _,reference_dir=snapshot_names(snapshot_version)
    rows=[]
    for book in ALL_BOOKS:
        refrow,model,rapidrow=refs[book],three_rows[book],rapids[book]
        page=refrow["physical_page"]
        if model["physical_page"]!=page or rapidrow["physical_page"]!=page:
            raise VisualGateError("GOLD_GRADE_PHYSICAL_PAGE_CHANGED")
        png_sha=source_png(folder,native,book,page)
        output={ "book_id":book, "physical_page":page,
            "reference_state":"MISSING",
            "reference_scope":None,
            "source_image_sha_verified":True,
            "reference_source_image_bound":False,
            "normalized_alnum_characters":None,
            "normalized_alnum_cer":{engine:None for engine in ENGINES},
            "figure_semantics_verified":False,
            "punctuation_layout_and_reading_order_scored":False,
        }
        if refrow["reference_state"]=="INDEPENDENT_REFERENCE_NOT_PROVIDED":
            rows.append(output)
            continue
        if refrow["reference_state"]!="ATTESTED_REFERENCE_CER_COMPUTED":
            raise VisualGateError("GOLD_GRADE_REFERENCE_STATE_INVALID")
        receipt=folder/reference_dir/f"{book}_p{page:04d}.verified.private.json"
        candidate=private_load(receipt)
        if candidate.get("source_page_png_sha256_private")!=png_sha:
            raise VisualGateError("GOLD_GRADE_REVIEW_SOURCE_IMAGE_NOT_ATTESTED")
        # Reuse strict complete-page, independent origin, textual SHA and
        # reviewer attestation constraints from the existing v1-v12 gate.
        baseline={
            "book_id":book,
            "physical_page":page,
            "source_pdf_sha256_private":refrow["original_pdf_source_sha256_private"],
        }
        reference=admit_reference(candidate,baseline,gold["corpus_id"],
                                  reference_file=receipt)
        if refrow["reference_normalized_chars"]!=len(reference):
            raise VisualGateError("GOLD_GRADE_REFERENCE_SNAPSHOT_CHANGED")
        rapid_text=rapidrow["rapidocr_private_rows"]
        if (not isinstance(rapid_text,list) or
                any(not isinstance(x,dict) or not isinstance(x.get("text"),str) for x in rapid_text)):
            raise VisualGateError("GOLD_GRADE_RAPID_ROWS_INVALID")
        r=lexical("\n".join(x["text"] for x in rapid_text))
        md_file=folder/(B31_MD if book=="B31" else file_names(book)[1])
        md=read_bytes(md_file,MAX_MD)
        m=lexical(mineru_lexical_source(md.decode("utf-8")))
        worker_file=(folder/STANDARD_WORKER if book=="B15"
                     else worker_paths(folder,book)[1])
        worker=read_bytes(worker_file,MAX_WORKER)
        data,worker_chars=valid_worker(worker)
        d=lexical(mineru_lexical_source(data["private_markdown"]))
        if (digest(md)!=model["mineru_markdown_sha256_private"] or
                digest(worker)!=model["standard_worker_sha256_private"] or
                rapidrow.get("private_rows_sha256")!=model["rapidocr_rows_sha256_private"] or
                len(r)!=model["normalized_characters"][ENGINES[0]] or
                len(m)!=model["normalized_characters"][ENGINES[1]] or
                len(d)!=model["normalized_characters"][ENGINES[2]] or
                len(d)!=worker_chars):
            raise VisualGateError("GOLD_GRADE_FROZEN_THREE_ENGINE_BYTES_CHANGED")
        output.update({
            "reference_state":"ATTESTED_FULL_PAGE_SOURCE_PNG_BOUND",
            "reference_scope":"COMPLETE_PHYSICAL_PAGE_TEXT",
            "reference_source_image_bound":True,
            "normalized_alnum_characters":len(reference),
            "normalized_alnum_cer":score_alnum_only(reference,{
                ENGINES[0]:r,ENGINES[1]:m,ENGINES[2]:d,
            }),
        })
        rows.append(output)
    approved=sum(x["reference_source_image_bound"] for x in rows)
    return {
        "schema_version":1, "source_reference_snapshot":snapshot_version,
        "evidence":EVIDENCE,"page_count":5,"graded_page_count":approved,
        "not_graded_count":5-approved,
        "source_page_png_sha_required_for_gold":True,
        "external_independent_approval_truth_not_automatically_verified":True,
        "normalized_alnum_scores_are_not_full_page_visual_accuracy":True,
        "zero_new_model_calls":True,"rows":rows,
    }


def report_name(version):
    snapshot_names(version)
    return REPORT+f".v{version}.private.json"


def execute(root,manifest,*,snapshot_version=1,write=False,audit=False,
            compute_fn=compute):
    if write==audit:
        raise VisualGateError("GOLD_GRADE_EXPLICIT_MODE_REQUIRED")
    folder=_private_folder(root)
    path=folder/report_name(snapshot_version)
    if not audit and (path.exists() or path.is_symlink()):
        raise VisualGateError("GOLD_GRADE_REPORT_ALREADY_FROZEN")
    data=compute_fn(root,manifest,snapshot_version=snapshot_version)
    blob=(json.dumps(data,sort_keys=True,ensure_ascii=False,
                     separators=(",",":"))+"\n").encode("utf-8")
    if len(blob)>MAX_REPORT:
        raise VisualGateError("GOLD_GRADE_REPORT_SIZE_INVALID")
    if audit:
        if path.is_symlink() or not path.is_file() or path.read_bytes()!=blob:
            raise VisualGateError("GOLD_GRADE_FROZEN_REPORT_CHANGED")
    else:
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(path,flags,0o600),"wb") as stream:
            stream.write(blob)
    return data


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    parser.add_argument("--snapshot-version",type=int,default=1)
    group=parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--write",action="store_true")
    group.add_argument("--audit-only",action="store_true")
    group.add_argument("--check-only",action="store_true")
    args=parser.parse_args(argv)
    try:
        raw=Path(args.manifest).read_bytes()
        manifest=json.loads(raw,object_pairs_hook=no_duplicate_keys,parse_constant=reject_constant)
        if args.check_only:
            receipt=compute(args.private_root,manifest,
                            snapshot_version=args.snapshot_version)
        else:
            receipt=execute(args.private_root,manifest,
                            snapshot_version=args.snapshot_version,
                            write=args.write,audit=args.audit_only)
        status=("READONLY_CHECKED" if args.check_only else
                "PRIVATE_CREATED" if args.write else "PRIVATE_AUDIT_PASS")
        print("ACS_GOLD_THREE_ENGINE="+status)
        print("ACS_GOLD_THREE_ENGINE_TOTAL=5")
        print("ACS_GOLD_THREE_ENGINE_GRADED="+str(receipt["graded_page_count"]))
        print("ACS_GOLD_THREE_ENGINE_UNGRADED="+str(receipt["not_graded_count"]))
        print("ACS_GOLD_THREE_ENGINE_MODEL_CALLS=0")
    except Exception:
        print("ACS_GOLD_THREE_ENGINE=REJECTED")
        return 2
    return 0


if __name__=="__main__":
    sys.exit(main())
