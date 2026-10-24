#!/usr/bin/env python3
"""Source-bound private B15 p109 3x3 extra-character localization.

Uses only immutable existing real OCR receipts. Leftmost/rightmost complete
subsequence alignments are BOTH retained to expose repeated-character anchor
ambiguity. A character absent from selected alignments is not an OCR error.
Never export text, individual boxes, model weights or source filenames.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

from ebook_b15_three_engine_consensus import (
    execute as audit_three, REPORT as V5, STANDARD_WORKER, _source_file,
    _decode_json, MAX_MD,
)
from ebook_b15_order_sections import execute as audit_order
from ebook_b15_spatial_disagreement import (
    execute as audit_spatial, coarse_cell,
)
from ebook_multibook_rapidocr_matrix import audit_existing as audit_rapid
from ebook_multibook_native_matrix import (
    audit_existing as audit_native, _private_folder,
)
from ebook_fivebook_mineru_basic_matrix import file_names
from ebook_fivebook_text_consensus import lexical,mineru_lexical_source
from ebook_private_glm_visual_reference import VisualGateError

REPORT="b15_threeway_spatial_character_gap.v6.private.json"
EVIDENCE="B15_THREEWAY_SPATIAL_EXTRA_CHARACTERS_TWO_ANCHORS_NOT_OCR_TRUTH"
ENGINE_NAMES=("RAPIDOCR_STANDALONE","MINERU_BASIC","DOCLING_STANDARD_RAPIDOCR")
MAX_RECEIPT=25000
MAX_NORMALIZED_CHARS=5000


def complete_subsequence_positions(source,target,*,reverse=False):
    """Return one deterministic complete alignment, never heuristic partial."""
    if (not isinstance(source,str) or not isinstance(target,str)
            or len(source)>MAX_NORMALIZED_CHARS
            or not target or len(target)>len(source)):
        raise VisualGateError("B15_GAP_SUBSEQUENCE_INPUT_INVALID")
    matches=[]
    if reverse:
        cursor=len(source)
        for char in reversed(target):
            index=source.rfind(char,0,cursor)
            if index<0:
                raise VisualGateError("B15_GAP_SUBSEQUENCE_NOT_COMPLETE")
            matches.append(index)
            cursor=index
        matches.reverse()
    else:
        cursor=0
        for char in target:
            index=source.find(char,cursor)
            if index<0:
                raise VisualGateError("B15_GAP_SUBSEQUENCE_NOT_COMPLETE")
            matches.append(index)
            cursor=index+1
    if (len(matches)!=len(target) or
            matches!=sorted(set(matches)) or
            "".join(source[i] for i in matches)!=target):
        raise VisualGateError("B15_GAP_SUBSEQUENCE_INVARIANT_FAILED")
    return set(matches)


def aggregate_unmatched(cells,source,target):
    """Per-cell extras under both complete subsequence anchor choices."""
    if not isinstance(cells,list) or len(cells)!=len(source):
        raise VisualGateError("B15_GAP_CELL_MAPPING_INVALID")
    if any(type(i) is not int or i<0 or i>8 for i in cells):
        raise VisualGateError("B15_GAP_CELL_OUT_OF_BOUNDS")
    left=complete_subsequence_positions(source,target)
    right=complete_subsequence_positions(source,target,reverse=True)
    output=[{
        "row":k//3+1,"col":k%3+1,"standalone_rapidocr_characters":0,
        "extra_vs_target_earliest_anchor":0,
        "extra_vs_target_latest_anchor":0,
        "extra_both_anchor_choices":0,
        "anchor_assignment_disagreement":0,
    } for k in range(9)]
    for i,cell_id in enumerate(cells):
        entry=output[cell_id]
        entry["standalone_rapidocr_characters"]+=1
        not_left=i not in left
        not_right=i not in right
        entry["extra_vs_target_earliest_anchor"]+=int(not_left)
        entry["extra_vs_target_latest_anchor"]+=int(not_right)
        entry["extra_both_anchor_choices"]+=int(not_left and not_right)
        entry["anchor_assignment_disagreement"]+=int(not_left!=not_right)
    extra=len(source)-len(target)
    if (sum(x["extra_vs_target_earliest_anchor"] for x in output)!=extra
            or sum(x["extra_vs_target_latest_anchor"] for x in output)!=extra):
        raise VisualGateError("B15_GAP_EXTRA_CHARACTERS_NOT_CONSERVED")
    return output


def quartile_gap(source,target):
    """Text ordinal quartile only; not spatial page position."""
    left=complete_subsequence_positions(source,target)
    right=complete_subsequence_positions(source,target,reverse=True)
    rows=[]
    for q in range(4):
        indices=[i for i in range(len(source)) if (i*4//len(source))==q]
        rows.append({
            "ordinal_quarter_not_page_geometry":q+1,
            "mineru_source_characters":len(indices),
            "extra_vs_docling_earliest_anchor":sum(i not in left for i in indices),
            "extra_vs_docling_latest_anchor":sum(i not in right for i in indices),
            "anchor_assignment_disagreement":sum((i in left)!=(i in right)
                                                for i in indices),
        })
    assert sum(x["extra_vs_docling_earliest_anchor"] for x in rows)==len(source)-len(target)
    assert sum(x["extra_vs_docling_latest_anchor"] for x in rows)==len(source)-len(target)
    return rows


def compute(root,manifest):
    folder=_private_folder(root)
    baseline=audit_three(root,manifest,audit=True)
    spatial=audit_spatial(root,manifest,audit=True)
    order=audit_order(root,manifest,audit=True)
    rapid=audit_rapid(root,manifest)
    native=audit_native(root,manifest)
    if (baseline.get("book_id")!="B15" or baseline.get("physical_page")!=109
            or baseline.get("third_engine_actual_full_page_ocr_completed") is not True
            or baseline.get("source_same_original_book_and_physical_page") is not True
            or baseline.get("cer",object()) is not None
            or baseline.get("new_ocr_calls")!=0
            or order.get("corpus_id")!=baseline.get("corpus_id")
            or spatial.get("corpus_id")!=baseline.get("corpus_id")):
        raise VisualGateError("B15_GAP_V5_SOURCE_NOT_VERIFIED")
    rap=[x for x in rapid.get("pages",[])
         if (x.get("book_id"),x.get("physical_page"))==("B15",109)]
    image=[(book,page) for book in native.get("rows",[])
           if book.get("book_id")=="B15"
           for page in book.get("pages",[]) if page.get("physical_page")==109]
    if len(rap)!=1 or len(image)!=1:
        raise VisualGateError("B15_GAP_SOURCE_PAGE_NOT_UNIQUE")
    record=rap[0]
    book,page=image[0]
    if (record.get("private_rows_sha256")!=baseline.get(
            "private_standalone_rapidocr_rows_sha256")
            or record.get("source_document_sha256")!=book.get(
                "source_document_sha256")
            or book.get("source_document_sha256")!=spatial.get(
                "original_source_pdf_sha256_private")
            or record.get("render_png_sha256")!=page.get(
                "ocr_focus_png_sha256")
            or record.get("rapidocr_line_count")!=order.get(
                "rapidocr_line_count")):
        raise VisualGateError("B15_GAP_SOURCE_SHA_MISMATCH")
    width=page.get("ocr_focus_width")
    height=page.get("ocr_focus_height")
    rows=record.get("rapidocr_private_rows")
    if not isinstance(rows,list):
        raise VisualGateError("B15_GAP_RAPID_ROWS_INVALID")
    mapped=[]
    parts=[]
    for line in rows:
        if not isinstance(line,dict) or not isinstance(line.get("text"),str):
            raise VisualGateError("B15_GAP_RAPID_LINE_INVALID")
        part=lexical(line["text"])
        grid_id=coarse_cell(line.get("quad"),width,height)
        parts.append(part)
        mapped.extend([grid_id]*len(part))
    source=lexical("\n".join(row["text"] for row in rows))
    if source!="".join(parts) or len(source)!=order.get("rapidocr_chars"):
        raise VisualGateError("B15_GAP_RAPID_LEXICAL_ALIGNMENT_INVALID")
    mineru_raw=_source_file(folder/file_names("B15")[1],MAX_MD)
    if hashlib.sha256(mineru_raw).hexdigest()!=baseline.get(
            "private_mineru_markdown_sha256"):
        raise VisualGateError("B15_GAP_MINERU_SHA_CHANGED")
    try:
        mineru=lexical(mineru_lexical_source(mineru_raw.decode("utf-8")))
    except UnicodeError:
        raise VisualGateError("B15_GAP_MINERU_SOURCE_UTF8_INVALID") from None
    standard_raw=_source_file(folder/STANDARD_WORKER,400000)
    if hashlib.sha256(standard_raw).hexdigest()!=baseline.get(
            "private_standard_worker_sha256"):
        raise VisualGateError("B15_GAP_STANDARD_SHA_CHANGED")
    worker=_decode_json(standard_raw)
    if (worker.get("pipeline")!="REAL_STANDARD_PDF_LAYOUT_AND_RAPIDOCR_CH_ONNX_CPU"
            or worker.get("ocr_explicitly_enabled") is not True
            or not isinstance(worker.get("private_markdown"),str)):
        raise VisualGateError("B15_GAP_STANDARD_WORKER_INVALID")
    standard=lexical(mineru_lexical_source(worker["private_markdown"]))
    lengths=[len(source),len(mineru),len(standard)]
    if ([row.get("normalized_characters") for row in baseline.get("engines",[])]
            !=lengths or not lengths[0]>=lengths[1]>=lengths[2]>0):
        raise VisualGateError("B15_GAP_FROZEN_CHARACTER_COUNTS_CHANGED")
    pairs=baseline.get("pairs",[])
    if (len(pairs)!=3 or any(
            pairs[i].get("ordered_common_subsequence_characters")!=lengths[j]
            or pairs[i].get("sequence_order_gap_not_accuracy")!=0
            for i,j in enumerate((1,2,2)))):
        raise VisualGateError("B15_GAP_FROZEN_SUBSEQUENCE_INVARIANT_INVALID")
    first=aggregate_unmatched(mapped,source,mineru)
    second=aggregate_unmatched(mapped,source,standard)
    # Each cell uses exactly the same rapidocr boxes for both projections.
    if any(first[i]["standalone_rapidocr_characters"]!=
           second[i]["standalone_rapidocr_characters"] for i in range(9)):
        raise VisualGateError("B15_GAP_IMAGE_GRID_MISMATCH")
    original_cells=spatial.get("cells_3x3_row_major",[])
    if (len(original_cells)!=9 or any(first[i][
            "standalone_rapidocr_characters"]!=original_cells[i].get(
                "normalized_characters") for i in range(9))):
        raise VisualGateError("B15_GAP_ORIGINAL_SPATIAL_RECEIPT_CHANGED")
    return {
        "schema_version":6,"evidence":EVIDENCE,
        "book_id":"B15","physical_page":109,"corpus_id":baseline["corpus_id"],
        "v5_private_receipt_sha256":hashlib.sha256(
            _source_file(folder/V5,40000)).hexdigest(),
        "original_page_png_sha256_private":page["ocr_focus_png_sha256"],
        "rapidocr_normalized_characters":lengths[0],
        "mineru_normalized_characters":lengths[1],
        "docling_standard_rapidocr_normalized_characters":lengths[2],
        "rapidocr_minus_mineru_characters":lengths[0]-lengths[1],
        "rapidocr_minus_docling_characters":lengths[0]-lengths[2],
        "mineru_minus_docling_characters":lengths[1]-lengths[2],
        "extra_vs_mineru_3x3_two_anchor_alignments":first,
        "extra_vs_docling_3x3_two_anchor_alignments":second,
        "mineru_vs_docling_extra_text_ordinal_quarters":quartile_gap(
            mineru,standard),
        "subsequence_complete_in_both_anchors":True,
        "multiple_alignment_choices_possible":any(
            x["anchor_assignment_disagreement"] for x in first+second),
        "no_independent_ocr_truth":True,
        "unmatched_characters_are_not_verified_ocr_errors":True,
        "cer":None,"accuracy_winner":None,
        "new_ocr_calls":0,"new_cloud_calls":0,"model_downloads":0,
    }


def execute(root,manifest,*,write=False,audit=False):
    folder=_private_folder(root)
    report=folder/REPORT
    if not audit and (report.exists() or report.is_symlink()):
        raise VisualGateError("B15_GAP_PRIVATE_REPORT_ALREADY_EXISTS")
    result=compute(root,manifest)
    raw=(json.dumps(result,sort_keys=True,ensure_ascii=False,
                    separators=(",",":"))+"\n").encode("utf-8")
    if len(raw)>MAX_RECEIPT:
        raise VisualGateError("B15_GAP_REPORT_TOO_LARGE")
    if audit:
        if report.is_symlink() or not report.is_file() or report.read_bytes()!=raw:
            raise VisualGateError("B15_GAP_PRIVATE_REPORT_CHANGED")
    elif write:
        flags=os.O_EXCL|os.O_CREAT|os.O_WRONLY
        if hasattr(os,"O_NOFOLLOW"):
            flags|=os.O_NOFOLLOW
        with os.fdopen(os.open(report,flags,0o600),"wb") as out:
            out.write(raw)
    return result


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument("--private-root",required=True)
    parser.add_argument("--manifest",required=True)
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument("--write",action="store_true")
    mode.add_argument("--audit-only",action="store_true")
    args=parser.parse_args(argv)
    manifest=json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    result=execute(Path(args.private_root),manifest,
                   write=args.write,audit=args.audit_only)
    print("ACS_B15_GAP_STATUS="+("PRIVATE_CREATED" if args.write else
                                "PRIVATE_VERIFIED" if args.audit_only else
                                "READONLY_READY"))
    print("ACS_B15_GAP_PAGE=109")
    for side,name in (("extra_vs_mineru_3x3_two_anchor_alignments","MINERU"),
                      ("extra_vs_docling_3x3_two_anchor_alignments","DOCLING")):
        for cell in result[side]:
            key=f'ACS_B15_GAP_{name}_R{cell["row"]}C{cell["col"]}'
            print(key+"_EXTRA_LEFT="+str(cell["extra_vs_target_earliest_anchor"]))
            print(key+"_EXTRA_RIGHT="+str(cell["extra_vs_target_latest_anchor"]))
    print("ACS_B15_GAP_MINERU_MINUS_DOCLING="+str(
        result["mineru_minus_docling_characters"]))
    print("ACS_B15_GAP_TRUTH=UNVERIFIED")
    print("ACS_B15_GAP_NEW_OCR_CALLS=0")


if __name__=="__main__":
    try:
        main()
    except (VisualGateError,ValueError,TypeError,UnicodeError,OSError,RuntimeError):
        print("ACS_B15_GAP_REJECTED=PRIVATE_SOURCE_OR_ALIGNMENT_GATE")
        sys.exit(2)
