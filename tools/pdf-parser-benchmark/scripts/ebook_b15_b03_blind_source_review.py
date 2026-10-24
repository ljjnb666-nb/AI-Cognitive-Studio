#!/usr/bin/env python3
"""Produce a private, BLIND, source-only review packet for B15 R3C2 & B03 p67.

No OCR text, candidate text, pseudo-ground truth, reviewer approval, or CER.
Use native 24-page source SHA + v8 three-engine and v6 spatial frozen receipts.
Private PNGs and blank reviewer forms are created once, and audit-only proves
immutability. The reviewer may create a SEPARATE later attested reference; this
stage NEVER writes into independent_reference_vN or claims human verification.
"""
import argparse
from io import BytesIO
import hashlib
import json
import os
from pathlib import Path
import sys

from ebook_multibook_native_matrix import audit_existing as audit_native, _private_folder, MAX_PNG
from ebook_fivebook_three_engine_crossbook import execute as audit_v8, REPORT as V8
from ebook_b15_threeway_gap_spatial import execute as audit_v6, REPORT as V6
from ebook_private_graph_receipt_audit import no_duplicate_keys,reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b15_b03_source_blind_review_packet.v9.private.json"
EVIDENCE="SOURCE_IMAGE_ONLY_BLIND_REVIEW_NO_REFERENCE_NO_CER"
TARGETS=(("B15",109,"R3C2"),("B03",67,"FULL"))
SUBDIR="blind_source_review_v9"
MAX_REPORT=16000
MAX_FORM=4000


def safe_bytes(path,limit):
    if (path.is_symlink() or not path.is_file()
            or not 0<path.stat().st_size<=limit):
        raise VisualGateError("BLIND_SOURCE_FILE_MISSING_OR_UNSAFE")
    return path.read_bytes()


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def frozen_json(path,limit):
    try:
        return json.loads(safe_bytes(path,limit).decode("utf-8"),
                          object_pairs_hook=no_duplicate_keys,
                          parse_constant=reject_constant)
    except (ValueError,UnicodeError,TypeError):
        raise VisualGateError("BLIND_SOURCE_JSON_INVALID") from None


def exclusive(path,raw):
    flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY
    if hasattr(os,"O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    with os.fdopen(os.open(path,flags,0o600),"wb") as stream:
        stream.write(raw)


def crop_pixels(png,width,height,scope):
    """The sole image codec is the already installed, offline Pillow runtime."""
    from PIL import Image,ImageFile
    Image.MAX_IMAGE_PIXELS=4_000_000
    ImageFile.LOAD_TRUNCATED_IMAGES=False
    try:
        with Image.open(BytesIO(png)) as im:
            im.load()
            if (im.format!="PNG" or im.size!=(width,height)
                    or im.mode not in ("RGB","RGBA","L")):
                raise VisualGateError("BLIND_SOURCE_IMAGE_FORMAT_OR_SIZE_CHANGED")
            if scope=="FULL":
                return png,(0,0,width,height)
            if scope!="R3C2":
                raise VisualGateError("BLIND_SOURCE_CROP_SCOPE_INVALID")
            # Same normalized 3x3 original geometry as B15 v3 spatial map.
            region=(width//3,2*height//3,2*width//3,height)
            part=im.crop(region)
            buf=BytesIO()
            part.save(buf,format="PNG",optimize=False)
            data=buf.getvalue()
            if len(data)>MAX_PNG:
                raise VisualGateError("BLIND_SOURCE_CROP_PNG_TOO_LARGE")
            return data,region
    except VisualGateError:
        raise
    except (OSError,ValueError,MemoryError):
        raise VisualGateError("BLIND_SOURCE_PNG_DECODE_FAILED") from None


def source_rows(root,manifest,*,native_fn=audit_native,v8_fn=audit_v8,v6_fn=audit_v6):
    root=Path(root)
    folder=_private_folder(root)
    native=native_fn(root,manifest)
    v8=v8_fn(root,manifest,audit=True)
    v6=v6_fn(root,manifest,audit=True)
    if (native.get("selected_native_pages")!=24 or
            native.get("ocr_focus_image_count")!=5 or
            v8.get("same_original_page_count")!=5 or
            v8.get("independent_ocr_truth",object()) is not None or
            v8.get("accuracy_winner",object()) is not None or
            v6.get("book_id")!="B15" or v6.get("physical_page")!=109 or
            v6.get("no_independent_ocr_truth") is not True or
            v8.get("corpus_id")!=native.get("corpus_id") or
            v6.get("corpus_id")!=native.get("corpus_id")):
        raise VisualGateError("BLIND_SOURCE_UPSTREAM_NOT_AUTHORIZED")
    upstream_index={(r["book_id"],p["physical_page"]):(r,p)
            for r in native["rows"] for p in r["pages"]
            if "ocr_focus_png" in p}
    v8_index={(r["book_id"],r["physical_page"]):r for r in v8["rows"]}
    items=[]
    for book,page,scope in TARGETS:
        key=(book,page)
        if key not in upstream_index or key not in v8_index:
            raise VisualGateError("BLIND_SOURCE_TARGET_PAGE_MISSING")
        parent,focus=upstream_index[key]
        compare=v8_index[key]
        name=f"{book}_p{page:04d}.private.png"
        source=folder/name
        data=safe_bytes(source,MAX_PNG)
        if (focus.get("ocr_focus_png")!=name or
                sha(data)!=focus.get("ocr_focus_png_sha256") or
                compare.get("actual_real_standard_ocr") is not True or
                compare.get("physical_page")!=page or
                parent.get("source_document_sha256") is None or
                compare.get("same_original_single_page_sha256_private") is None):
            raise VisualGateError("BLIND_SOURCE_ORIGINAL_IMAGE_PROVENANCE_FAILED")
        width,height=focus.get("ocr_focus_width"),focus.get("ocr_focus_height")
        if any(type(v) is not int or not 60<=v<=3000 for v in (width,height)):
            raise VisualGateError("BLIND_SOURCE_DIMENSIONS_INVALID")
        if scope=="R3C2":
            if (v6.get("original_page_png_sha256_private")!=sha(data) or
                    v6.get("multiple_alignment_choices_possible") is None):
                raise VisualGateError("BLIND_SOURCE_SPATIAL_B15_CHANGED")
        items.append({"book":book,"physical_page":page,"scope":scope,
                      "source_image":data,"image_size":(width,height),
                      "source_image_sha256_private":sha(data),
                      "original_pdf_sha256_private":parent["source_document_sha256"],
                      "single_page_pdf_sha256_private":
                          compare["same_original_single_page_sha256_private"]})
    return folder,items,native,v8,v6


def form(book,page,scope,source_sha,crop_sha):
    return {
        "schema_version":9,
        "book_id":book,"physical_page":page,"review_scope":scope,
        "source_render_png_sha256_private":source_sha,
        "review_image_sha256_private":crop_sha,
        "reference_status":"SOURCE_ONLY_BLIND_UNREVIEWED",
        "independent_review_performed":False,
        "reviewer_approval":None,
        "independent_transcript":None,
        "region_classification":None,
        "reviewer_record_id":None,
        "cer":None,
        "note":"Do not edit this frozen source-only form. Record independently verified text in a separate, reviewed artifact after inspecting the original image. ROI reference is NOT a full-page reference.",
    }


def compute(root,manifest,*,write=False,audit=False,render=crop_pixels,
            native_fn=audit_native,v8_fn=audit_v8,v6_fn=audit_v6):
    if write==audit:
        raise VisualGateError("BLIND_SOURCE_EXPLICIT_WRITE_OR_AUDIT_REQUIRED")
    folder,items,native,v8,v6=source_rows(root,manifest,
                    native_fn=native_fn,v8_fn=v8_fn,v6_fn=v6_fn)
    output=folder/REPORT
    review_dir=folder/SUBDIR
    if review_dir.is_symlink() or (review_dir.exists() and not review_dir.is_dir()):
        raise VisualGateError("BLIND_SOURCE_REVIEW_DIR_UNSAFE")
    if write and (output.exists() or output.is_symlink()):
        raise VisualGateError("BLIND_SOURCE_PACKET_ALREADY_FROZEN")
    snapshots=[]
    for item in items:
        book,page,scope=item["book"],item["physical_page"],item["scope"]
        key=f"{book}_p{page:04d}_{scope}"
        picture=review_dir/(key+".source.private.png")
        formfile=review_dir/(key+".blank.private.json")
        if write:
            if (picture.exists() or picture.is_symlink() or
                    formfile.exists() or formfile.is_symlink()):
                raise VisualGateError("BLIND_SOURCE_PARTIAL_PACKET_REQUIRES_AUDIT")
            rendered,rect=render(item["source_image"],*item["image_size"],scope)
            if not isinstance(rendered,bytes) or not 0<len(rendered)<=MAX_PNG:
                raise VisualGateError("BLIND_SOURCE_RENDER_OUTPUT_INVALID")
            if (not isinstance(rect,tuple) or len(rect)!=4 or
                    any(type(v) is not int for v in rect)):
                raise VisualGateError("BLIND_SOURCE_CROP_GEOMETRY_INVALID")
            width,height=item["image_size"]
            expected=(0,0,width,height) if scope=="FULL" else (
                width//3,2*height//3,2*width//3,height)
            if rect!=expected:
                raise VisualGateError("BLIND_SOURCE_CROP_RECT_CHANGED")
            blob=(json.dumps(form(book,page,scope,
                         item["source_image_sha256_private"],sha(rendered)),
                         ensure_ascii=False,sort_keys=True,
                         separators=(",",":"))+"\n").encode("utf-8")
            if len(blob)>MAX_FORM:
                raise VisualGateError("BLIND_SOURCE_FORM_TOO_LARGE")
            if not review_dir.exists():
                review_dir.mkdir(mode=0o700)
            exclusive(picture,rendered)
            exclusive(formfile,blob)
        raw=safe_bytes(picture,MAX_PNG)
        candidate=frozen_json(formfile,MAX_FORM)
        if (candidate!=form(book,page,scope,item["source_image_sha256_private"],
                            sha(raw)) or candidate["independent_review_performed"] is not False):
            raise VisualGateError("BLIND_SOURCE_BLANK_FORM_MUTATED")
        if scope=="FULL" and raw!=item["source_image"]:
            raise VisualGateError("BLIND_SOURCE_FULL_IMAGE_NOT_BYTE_EXACT")
        snapshots.append({
            "book_id":book,"physical_page":page,"scope":scope,
            "image_only_no_ocr_text":True,
            "source_image_sha256_private":item["source_image_sha256_private"],
            "cropped_image_sha256_private":sha(raw),
            "blank_form_sha256_private":sha(safe_bytes(formfile,MAX_FORM)),
            "original_pdf_sha256_private":item["original_pdf_sha256_private"],
            "single_page_pdf_sha256_private":item["single_page_pdf_sha256_private"],
            "reference_status":"BLIND_UNREVIEWED",
            "cer":None,
        })
    data={
        "schema_version":9,"evidence":EVIDENCE,
        "corpus_id":native["corpus_id"],
        "v8_source_receipt_sha256_private":sha(safe_bytes(folder/V8,40000)),
        "v6_spatial_receipt_sha256_private":sha(safe_bytes(folder/V6,25000)),
        "image_count":2,"reviewed_reference_count":0,
        "independent_reference_created":False,
        "any_ocr_candidate_visible_in_review_packet":False,
        "scope_specific_review_required":True,
        "cer":None,"quality_winner":None,
        "new_model_calls":0,"cloud_calls":0,"model_downloads":0,
        "pages":snapshots,
    }
    data_blob=(json.dumps(data,ensure_ascii=False,sort_keys=True,
               separators=(",",":"))+"\n").encode("utf-8")
    if len(data_blob)>MAX_REPORT:
        raise VisualGateError("BLIND_SOURCE_REPORT_LIMIT")
    if write:
        exclusive(output,data_blob)
    elif safe_bytes(output,MAX_REPORT)!=data_blob:
        raise VisualGateError("BLIND_SOURCE_FROZEN_REPORT_CHANGED")
    return data


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--private-root",required=True)
    p.add_argument("--manifest",required=True)
    g=p.add_mutually_exclusive_group(required=True)
    g.add_argument("--write",action="store_true")
    g.add_argument("--audit-only",action="store_true")
    args=p.parse_args()
    manifest=frozen_json(Path(args.manifest),200000)
    result=compute(Path(args.private_root),manifest,
                   write=args.write,audit=args.audit_only)
    print("ACS_BLIND_REVIEW_STATUS="+("PRIVATE_CREATED" if args.write else "PRIVATE_VERIFIED"))
    print("ACS_BLIND_REVIEW_SOURCE_IMAGE_COUNT="+str(result["image_count"]))
    print("ACS_BLIND_REVIEW_INDEPENDENT_REFERENCES=0")
    print("ACS_BLIND_REVIEW_ACTUAL_HUMAN_APPROVAL=NONE")
    print("ACS_BLIND_REVIEW_CER=UNVERIFIED")
    print("ACS_BLIND_REVIEW_MODEL_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,TypeError,UnicodeError,OSError,RuntimeError):
        print("ACS_BLIND_REVIEW_REJECTED=SOURCE_OR_PRIVATE_IMAGE_GATE")
        sys.exit(2)
