#!/usr/bin/env python3
"""B31 real MinerU Markdown image/data payload accounting, NOT OCR ground truth.

Never print private OCR text, links, markdown, source page coordinates or
user filenames. Only source-bound aggregate structure counts leave the host.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys

from ebook_b31_mineru_basic_stateless import (
    audit_existing as audit_mineru, MARKDOWN as SOURCE_MD
)
from ebook_b31_rapidocr_isolated import audit_existing as audit_rapidocr
from ebook_multibook_native_matrix import _private_folder
from ebook_private_graph_receipt_audit import no_duplicate_keys,reject_constant
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b31_mineru403_basic_markdown_structure.private.json"
EVIDENCE="MINERU_B31_MARKDOWN_IMAGE_VS_TEXT_ACCOUNTING_NOT_OCR_GOLD"
MAX_SOURCE=1_500_000
MAX_REPORT=25_000
DATA_URI=re.compile(r"data:image/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+",re.I)
MD_IMAGE=re.compile(r"!\[[^\]\n]{0,1000}\]\((?:[^)\n]|%29){0,1200}\)")
HTML_IMAGE=re.compile(r"<img\b[^>]{0,2000}>",re.I)
FENCED_CODE=re.compile(r"(?m)^[ \t]*(\x60{3}|~~~)")
PIPE_TABLE=re.compile(r"(?m)^[ \t]*\|[^\n]{1,2000}\|[ \t]*$")
LATEX_BLOCK=re.compile(r"(?m)\$\$|\\\[|\\\]")
HTML_TAG=re.compile(r"<[a-zA-Z/][^>]{0,2500}>")
LINK_LABEL=re.compile(r"\[([^\]\n]{0,1000})\]\([^)\n]{0,2000}\)")
MARKDOWN_TOKEN=re.compile(r"(?m)^[ \t]{0,6}(?:#{1,6}\s+|[-*+]\s+|[0-9]+\.\s+)")
WHITESPACE=re.compile(r"\s+")


def count_structure(content):
    if not isinstance(content,str) or len(content)>MAX_SOURCE:
        raise VisualGateError("MINERU_MD_STRUCT_SOURCE_SIZE_INVALID")
    embedded=list(DATA_URI.finditer(content))
    embedded_char_count=sum(len(m.group()) for m in embedded)
    without_data=DATA_URI.sub("[PRIVATE_EMBEDDED_IMAGE]",content)
    md_images=MD_IMAGE.findall(without_data)
    html_images=HTML_IMAGE.findall(without_data)
    without_images=HTML_IMAGE.sub("",MD_IMAGE.sub("",without_data))
    without_tags=HTML_TAG.sub("",without_images)
    without_links=LINK_LABEL.sub(lambda m:m.group(1),without_tags)
    residue=WHITESPACE.sub("",MARKDOWN_TOKEN.sub("",without_links))
    return {
        "markdown_raw_character_count":len(content),
        "markdown_raw_utf8_bytes":len(content.encode("utf-8")),
        "embedded_image_data_uri_count":len(embedded),
        "embedded_image_data_uri_raw_characters":embedded_char_count,
        "markdown_image_reference_count":len(md_images),
        "html_image_tag_count":len(html_images),
        "fenced_code_delimiter_count":len(FENCED_CODE.findall(content)),
        "pipe_table_line_count":len(PIPE_TABLE.findall(content)),
        "latex_block_marker_count":len(LATEX_BLOCK.findall(content)),
        "nonwhitespace_nonimage_markdown_residue_chars":len(residue),
        "markdown_residue_is_not_certified_ocr_text":True,
        "base64_image_payloads_are_not_ocr_text":True,
    }


def compute(root,manifest):
    mineru=audit_mineru(root,manifest)
    rapid=audit_rapidocr(root,manifest)
    if (mineru.get("book_id")!="B31" or mineru.get("physical_page")!=126 or
            rapid.get("book_id")!="B31" or rapid.get("physical_page")!=126 or
            mineru.get("real_inference") is not True or
            rapid.get("recognized_line_count")!=50 or
            rapid.get("recognized_character_count")!=1191):
        raise VisualGateError("MINERU_MD_STRUCT_UPSTREAM_SOURCE_INVALID")
    folder=_private_folder(root)
    src=folder/SOURCE_MD
    if src.is_symlink() or not src.is_file() or not 0<src.stat().st_size<=MAX_SOURCE:
        raise VisualGateError("MINERU_MD_STRUCT_SOURCE_NOT_FOUND")
    try:
        content=src.read_text(encoding="utf-8")
    except UnicodeError:
        raise VisualGateError("MINERU_MD_STRUCT_DECODE_FAILED") from None
    measured=count_structure(content)
    if (measured["markdown_raw_character_count"]!=mineru["markdown_character_count"] or
            measured["markdown_raw_utf8_bytes"]!=mineru["markdown_byte_count"]):
        raise VisualGateError("MINERU_MD_STRUCT_SOURCE_CHANGED")
    return {
        "schema_version":1,
        "evidence":EVIDENCE,
        "book_id":"B31",
        "physical_page":126,
        "same_original_pdf_page":True,
        "mineru_model_version":mineru["engine_version"],
        "mineru_entrypoint":"mineru-kit parse",
        "mineru_tier":"basic",
        "mineru_ocr_mode":"ocr",
        "mineru_markdown_private_sha256":mineru["markdown_sha256_private"],
        "original_pdf_sha256":mineru["source_document_sha256"],
        "rapidocr_source_png_sha256":rapid["source_page_png_sha256"],
        "rapidocr_line_count":rapid["recognized_line_count"],
        "rapidocr_character_count":rapid["recognized_character_count"],
        "mineru":measured,
        "actual_ocr_transcription_quality":None,
        "table_structure_quality":None,
        "graph_quality":None,
        "provider_calls":0,
        "new_model_inference_calls":0,
    }


def run(root,manifest,*,write=False):
    folder=_private_folder(root)
    path=folder/REPORT
    if path.exists() or path.is_symlink():
        raise VisualGateError("MINERU_MD_STRUCT_RECEIPT_ALREADY_EXISTS")
    record=compute(root,manifest)
    payload=(json.dumps(record,sort_keys=True,separators=(",",":"))+"\n").encode("utf-8")
    if len(payload)>MAX_REPORT:
        raise VisualGateError("MINERU_MD_STRUCT_RECEIPT_TOO_LARGE")
    if write:
        flags=os.O_EXCL|os.O_CREAT|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(path,flags,0o600),"wb") as f:
            f.write(payload)
    return record


def audit_existing(root,manifest):
    path=_private_folder(root)/REPORT
    if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=MAX_REPORT:
        raise VisualGateError("MINERU_MD_STRUCT_PRIVATE_REPORT_MISSING")
    try:
        saved=json.loads(path.read_text(encoding="utf-8"),
            object_pairs_hook=no_duplicate_keys,parse_constant=reject_constant)
    except (UnicodeError,TypeError,ValueError):
        raise VisualGateError("MINERU_MD_STRUCT_PRIVATE_REPORT_JSON_INVALID") from None
    if saved!=compute(root,manifest):
        raise VisualGateError("MINERU_MD_STRUCT_PRIVATE_REPORT_PROVENANCE_INVALID")
    return saved


def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument("--private-root",required=True)
    p.add_argument("--manifest",required=True)
    modes=p.add_mutually_exclusive_group()
    modes.add_argument("--write",action="store_true")
    modes.add_argument("--audit-only",action="store_true")
    args=p.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    data=(audit_existing(Path(args.private_root),manifest) if args.audit_only else
          run(Path(args.private_root),manifest,write=args.write))
    fields=("markdown_raw_character_count","embedded_image_data_uri_count",
            "embedded_image_data_uri_raw_characters","markdown_image_reference_count",
            "html_image_tag_count","nonwhitespace_nonimage_markdown_residue_chars")
    print("ACS_MINERU_MD_STRUCT_STATUS="+(
        "PRIVATE_CREATED" if args.write else "PRIVATE_RECEIPT_VERIFIED" if args.audit_only
        else "READONLY_READY"))
    for field in fields:
        print("ACS_MINERU_MD_STRUCT_"+field.upper()+"="+str(data["mineru"][field]))
    print("ACS_MINERU_MD_STRUCT_OCR_CER=UNVERIFIED")
    print("ACS_MINERU_MD_STRUCT_NEW_MODEL_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,OSError,ValueError,TypeError):
        print("ACS_MINERU_MD_STRUCT_REJECTED=PRIVATE_RECEIPT_OR_SOURCE_INVALID")
        sys.exit(2)
