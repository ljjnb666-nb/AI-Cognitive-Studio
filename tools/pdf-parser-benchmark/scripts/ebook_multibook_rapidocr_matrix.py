#!/usr/bin/env python3
"""Five-book offline RapidOCR baseline, using already-staged SHA-pinned pages.

No PDF/ebook content, OCR text or coordinates printed or uploaded to GitHub.
CPU only, no cloud/provider, not OCR CER, never graph quality gold.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

from ebook_multibook_native_matrix import (audit_existing as audit_native,
                                           _private_folder,FOLDER)
from ebook_b31_rapidocr_isolated import (ocr_rows,probe_bundled_weights,EXPECTED)
from ebook_private_graph_receipt_audit import no_duplicate_keys,reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT="multibook_rapidocr_five_pages.private.json"
EVIDENCE="FIVE_ORIGINAL_PDF_PAGES_RAPIDOCR_OFFLINE_NOT_GOLD"
MAX_REPORT=1_200_000


def execute(root,manifest,cv2,np,*,write=False,engine=None,probe=None):
    native=audit_native(root,manifest)
    folder=_private_folder(root)
    output=folder/REPORT
    if output.exists() or output.is_symlink():
        raise VisualGateError("MATRIX_OCR_REPORT_EXISTS_NO_REPEAT")
    versions,hashes=probe_bundled_weights() if probe is None else probe
    if (versions!=EXPECTED or not isinstance(hashes,dict) or not hashes or
            any(not isinstance(v,str) or len(v)!=64 for v in hashes.values())):
        raise VisualGateError("MATRIX_OCR_MODEL_PROVENANCE_INVALID")
    if engine is None:
        from rapidocr import RapidOCR
        engine=RapidOCR()
    pages=[]
    for book in native["rows"]:
        for page in book["pages"]:
            if "ocr_focus_png" not in page:
                continue
            file=folder/page["ocr_focus_png"]
            if (file.is_symlink() or not file.is_file() or
                    hashlib.sha256(file.read_bytes()).hexdigest()!=page["ocr_focus_png_sha256"]):
                raise VisualGateError("MATRIX_OCR_STAGED_PAGE_TAMPERED")
            bgr=cv2.imdecode(np.frombuffer(file.read_bytes(),np.uint8),
                             cv2.IMREAD_COLOR)
            if (bgr is None or bgr.shape[:2] != (
                    page["ocr_focus_height"],page["ocr_focus_width"])):
                raise VisualGateError("MATRIX_OCR_STAGED_PAGE_SIZE_INVALID")
            before=time.perf_counter()
            rows=ocr_rows(bgr,engine)
            millis=round((time.perf_counter()-before)*1000)
            rows_sha=hashlib.sha256(json.dumps(
                rows,ensure_ascii=False,sort_keys=True,
                separators=(",",":")).encode("utf-8")).hexdigest()
            pages.append({
                "book_id":book["book_id"],
                "physical_page":page["physical_page"],
                "render_png_sha256":page["ocr_focus_png_sha256"],
                "source_document_sha256":book["source_document_sha256"],
                "duration_ms":millis,
                "native_char_count":page["native_char_count"],
                "rapidocr_line_count":len(rows),
                "rapidocr_char_count":sum(len(x["text"]) for x in rows),
                "rapidocr_private_rows":rows,
                "private_rows_sha256":rows_sha,
                "native_text_is_not_ground_truth":True,
            })
    if len(pages)!=5 or len(set(x["book_id"] for x in pages))!=5:
        raise VisualGateError("MATRIX_OCR_FIVE_BOOK_COVERAGE_INVALID")
    data={
        "schema_version":1,
        "evidence":EVIDENCE,
        "corpus_id":native["corpus_id"],
        "native_manifest_books":native["pdf_book_count"],
        "native_manifest_pages":native["selected_native_pages"],
        "ocr_books":5,
        "ocr_pages":5,
        "onnx_versions":versions,
        "bundled_model_hashes":hashes,
        "pages":pages,
        "native_text_is_not_gold":True,
        "ocr_accuracy_gold":None,
        "layout_accuracy_gold":None,
        "graph_accuracy_gold":None,
        "provider_calls":0,
        "model_downloads":0,
    }
    blob=(json.dumps(data,ensure_ascii=False,sort_keys=True,
                     separators=(",",":"))+"\n").encode("utf-8")
    if len(blob)>MAX_REPORT:
        raise VisualGateError("MATRIX_OCR_JSON_TOO_LARGE")
    if write:
        flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(output,flags,0o600),"wb") as f:
            f.write(blob)
    return data


def audit_existing(root,manifest):
    native=audit_native(root,manifest)
    folder=_private_folder(root)
    path=folder/REPORT
    if (path.is_symlink() or not path.is_file() or
            not 0<path.stat().st_size<=MAX_REPORT):
        raise VisualGateError("MATRIX_OCR_RECEIPT_MISSING")
    try:
        data=json.loads(path.read_text("utf-8"),
                        object_pairs_hook=no_duplicate_keys,
                        parse_constant=reject_constant)
    except (ValueError,TypeError,UnicodeError):
        raise VisualGateError("MATRIX_OCR_RECEIPT_JSON_INVALID") from None
    if (not isinstance(data,dict) or data.get("schema_version")!=1 or
            data.get("evidence")!=EVIDENCE or
            data.get("corpus_id")!=native["corpus_id"] or
            data.get("onnx_versions")!=EXPECTED or
            data.get("ocr_books")!=5 or data.get("ocr_pages")!=5 or
            data.get("native_manifest_pages")!=24 or
            data.get("provider_calls")!=0 or data.get("model_downloads")!=0 or
            data.get("native_text_is_not_gold") is not True or
            data.get("ocr_accuracy_gold",object()) is not None or
            data.get("layout_accuracy_gold",object()) is not None or
            data.get("graph_accuracy_gold",object()) is not None or
            not isinstance(data.get("pages"),list) or len(data["pages"])!=5):
        raise VisualGateError("MATRIX_OCR_RECEIPT_PROVENANCE_INVALID")
    model_hashes=data.get("bundled_model_hashes")
    if (not isinstance(model_hashes,dict) or not model_hashes or
            any(not isinstance(h,str) or len(h)!=64 or
                any(c not in "0123456789abcdef" for c in h)
                for h in model_hashes.values())):
        raise VisualGateError("MATRIX_OCR_RECEIPT_MODEL_HASH_INVALID")
    identity={
        (book["book_id"],page["physical_page"]):(book,page)
        for book in native["rows"] for page in book["pages"]
        if "ocr_focus_png" in page
    }
    seen=set()
    from ebook_b31_offline_ocr import parse_results
    for row in data["pages"]:
        if not isinstance(row,dict):
            raise VisualGateError("MATRIX_OCR_RECEIPT_ROW_INVALID")
        key=(row.get("book_id"),row.get("physical_page"))
        if key not in identity or key in seen:
            raise VisualGateError("MATRIX_OCR_RECEIPT_PAGE_IDENTITY_INVALID")
        seen.add(key)
        book,page=identity[key]
        if (row.get("render_png_sha256")!=page["ocr_focus_png_sha256"] or
                row.get("source_document_sha256")!=book["source_document_sha256"] or
                row.get("native_char_count")!=page["native_char_count"] or
                type(row.get("duration_ms")) is not int or row["duration_ms"]<0 or
                row.get("native_text_is_not_ground_truth") is not True or
                not isinstance(row.get("rapidocr_private_rows"),list)):
            raise VisualGateError("MATRIX_OCR_RECEIPT_SOURCE_CONFLICT")
        try:
            rows=parse_results([(r["quad"],r["text"],r["score"])
                                for r in row["rapidocr_private_rows"]],
                               page["ocr_focus_width"],page["ocr_focus_height"])
        except (KeyError,TypeError,ValueError):
            raise VisualGateError("MATRIX_OCR_RECEIPT_OCR_ROWS_INVALID") from None
        digest=hashlib.sha256(json.dumps(
            rows,ensure_ascii=False,sort_keys=True,
            separators=(",",":")).encode("utf-8")).hexdigest()
        if (rows!=row["rapidocr_private_rows"] or
                digest!=row.get("private_rows_sha256") or
                len(rows)!=row.get("rapidocr_line_count") or
                sum(len(x["text"]) for x in rows)!=row.get("rapidocr_char_count")):
            raise VisualGateError("MATRIX_OCR_RECEIPT_ROWS_TAMPERED")
    if seen!=set(identity):
        raise VisualGateError("MATRIX_OCR_RECEIPT_COVERAGE_LOST")
    return data


def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument("--private-root",required=True)
    p.add_argument("--manifest",required=True)
    opt=p.add_mutually_exclusive_group()
    opt.add_argument("--write",action="store_true")
    opt.add_argument("--audit-only",action="store_true")
    args=p.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text("utf-8"))
    if args.audit_only:
        data=audit_existing(Path(args.private_root),manifest)
    else:
        import cv2
        import numpy as np
        data=execute(Path(args.private_root),manifest,cv2,np,write=args.write)
    print("ACS_MULTIBOOK_OCR_STATUS="+(
        "PRIVATE_WRITTEN" if args.write else
        "PRIVATE_RECEIPT_VERIFIED" if args.audit_only else "READONLY_READY"))
    print("ACS_MULTIBOOK_OCR_BOOKS="+str(data["ocr_books"]))
    print("ACS_MULTIBOOK_OCR_PAGES="+str(data["ocr_pages"]))
    print("ACS_MULTIBOOK_OCR_LINES="+str(sum(x["rapidocr_line_count"] for x in data["pages"])))
    print("ACS_MULTIBOOK_OCR_CHARS="+str(sum(x["rapidocr_char_count"] for x in data["pages"])))
    print("ACS_MULTIBOOK_OCR_QUALITY=UNVERIFIED")
    print("ACS_MULTIBOOK_OCR_PROVIDER_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,TypeError,ImportError,RuntimeError,OSError) as err:
        print("ACS_MULTIBOOK_OCR_REJECTED="+(
            err.code if isinstance(err,VisualGateError) else type(err).__name__))
        sys.exit(2)
