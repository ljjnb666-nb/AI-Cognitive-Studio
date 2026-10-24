#!/usr/bin/env python3
"""Fail-closed, stdout-whitelisted private JSON acceptance guard for Windows CI.

NEVER print private receipt data or exception details to Actions logs.
The original checks have been moved here from PowerShell ConvertFrom-Json
because PowerShell parse failures may echo the entire private JSON input.
"""
import argparse
import json
from pathlib import Path
import sys

MAX_BYTES = 16_000_000
POLICIES = (
    "fivebook-standard", "fivebook-consensus", "blind-source",
    "blind-workbench", "edge-workbench",
    "legacy-b15-frame", "legacy-mineru-flash",
    "legacy-rotation", "legacy-visual-l2",
    "legacy-docling-real", "legacy-paddle-real",
)


class PrivateGateError(Exception):
    pass


def no_dupes(items):
    result = {}
    for key, value in items:
        if key in result:
            raise PrivateGateError("DUPLICATE_PRIVATE_JSON_KEY")
        result[key] = value
    return result


def deny_constant(_):
    raise PrivateGateError("NONFINITE_PRIVATE_JSON_NUMBER")


def require(condition):
    if not condition:
        raise PrivateGateError("PRIVATE_POLICY_REJECTED")


def read_private(path):
    file = Path(path)
    require(not file.is_symlink() and file.is_file())
    require(0 < file.stat().st_size <= MAX_BYTES)
    try:
        return json.loads(file.read_bytes().decode("utf-8"),
                          object_pairs_hook=no_dupes, parse_constant=deny_constant)
    except (UnicodeError, ValueError, TypeError):
        raise PrivateGateError("PRIVATE_JSON_PARSE_REJECTED") from None


def array(obj, name):
    value = obj.get(name)
    require(type(value) is list)
    return value


def mapping(value):
    require(type(value) is dict)
    return value


def docling_rows(value, *, require_success=False):
    rows=array(value, "rows")
    for row in rows:
        row=mapping(row)
        if require_success:
            require(row.get("status")=="SUCCESS")
        for metric in array(row, "results"):
            metric=mapping(metric)
            if metric.get("engine")!="Docling":
                continue
            layout=mapping(metric.get("layout_evidence"))
            require(layout.get("graph_semantics")=="UNVERIFIED")
    return rows


def verify(data, policy):
    data=mapping(data)
    require(policy in POLICIES)
    if policy=="fivebook-standard":
        require(data.get("all_five_real_standard_ocr_succeeded") is True)
        require(data.get("actual_standard_ocr_success_pages")==5)
        require(len(array(data,"rows"))==5)
        require(data.get("cer",object()) is None)
    elif policy=="fivebook-consensus":
        require(data.get("same_original_page_count")==5)
        require(len(array(data,"rows"))==5)
        require(data.get("independent_ocr_truth",object()) is None)
        require(data.get("cer",object()) is None)
    elif policy=="blind-source":
        require(data.get("image_count")==2)
        require(data.get("reviewed_reference_count")==0)
        require(data.get("independent_reference_created") is False)
        require(len(array(data,"pages"))==2)
        require(data.get("cer",object()) is None)
    elif policy in ("blind-workbench","edge-workbench"):
        require(len(array(data,"pages"))==2)
        require(data.get("independent_reference_created") is False)
        require(data.get("independent_review_count")==0)
        require(data.get("review_draft_export_only") is True)
        require(data.get("external_network_calls")==0)
        require(data.get("cer",object()) is None)
    elif policy=="legacy-b15-frame":
        rows=docling_rows(data)
        matched=[row for row in rows if row.get("book_id")=="B15"]
        require(len(matched)==1)
        engines=[m for m in array(matched[0],"results")
                 if mapping(m).get("engine")=="Docling"]
        require(len(engines)==1)
        layout=mapping(engines[0].get("layout_evidence"))
        require(layout.get("spatial_alignment") is not None)
    elif policy=="legacy-mineru-flash":
        require(len(array(data,"rows"))==3)
        require(len(array(data,"failed"))==0)
        require(len(array(data,"missing"))==0)
        for row in data["rows"]:
            row=mapping(row)
            require(row.get("status") in ("NATIVE_TEXT_EXTRACTED",
                                          "FLASH_NO_NATIVE_TEXT_CONTROL"))
            mapping(row.get("markdown_diagnostics"))
        diagnostics=mapping(data.get("model_root_diagnostics"))
        mapping(diagnostics.get("explicit_model_show"))
        mapping(diagnostics.get("inherited_model_show"))
    elif policy=="legacy-docling-real":
        require(len(array(data,"rows"))==3)
        require(len(array(data,"missing"))==0 and len(array(data,"failed"))==0)
        require(type(data.get("docling_version")) is str and bool(data["docling_version"]))
        require(data.get("docling_ocr_backend") in ("RapidOcrOptions","TesseractCliOcrOptions"))
        rows=docling_rows(data,require_success=True)
        pages={"B15":109,"B16":53,"B31":126}
        require({row.get("book_id") for row in rows}==set(pages))
        for row in rows:
            book=row["book_id"]
            require(row.get("physical_page")==pages[book])
            require(row.get("docling_status")=="SUCCESS")
            metrics=[m for m in row["results"] if m.get("engine")=="Docling"]
            require(len(metrics)==1)
            layout=metrics[0]["layout_evidence"]
            if book in ("B15","B31"):
                pictures=layout.get("picture_items")
                require(type(pictures) is int and pictures>0)
                require(layout.get("picture_boxes_with_geometry")==pictures)
                require(layout.get("source_pdf_rotation_degrees")==
                        (270 if book=="B15" else 0))
    elif policy=="legacy-paddle-real":
        require(len(array(data,"rows"))==3)
        require(len(array(data,"missing"))==0 and len(array(data,"failed"))==0)
        require(type(data.get("version")) is str and bool(data["version"]))
        pages={"B15":109,"B16":53,"B31":126}
        rows=data["rows"]
        require({mapping(row).get("book_id") for row in rows}==set(pages))
        for row in rows:
            require(row.get("physical_page")==pages[row["book_id"]])
            require(row.get("status")=="SUCCESS")
            chars=row.get("recognized_characters")
            require(type(chars) is int and chars>=0)
            require(mapping(row.get("layout_evidence")).get("graph_semantics")=="UNVERIFIED")
    elif policy=="legacy-rotation":
        require(len(array(data,"rows"))==3)
        require(len(array(data,"failed"))==0)
        require(len(array(data,"missing"))==0)
        for row in docling_rows(data,require_success=True):
            book=row.get("book_id")
            for metric in row["results"]:
                if metric.get("engine")!="Docling":
                    continue
                layout=metric["layout_evidence"]
                if book=="B15":
                    require(layout.get("source_pdf_rotation_degrees")==270)
                if book=="B31":
                    require(layout.get("source_pdf_rotation_degrees")==0)
                if book in ("B15","B31"):
                    count=layout.get("picture_items")
                    require(type(count) is int and count>0)
                    require(layout.get("picture_boxes_with_geometry")==count)
    elif policy=="legacy-visual-l2":
        require(len(array(data,"failed"))==0)
        require(len(array(data,"missing"))==0)
        for row in docling_rows(data):
            for metric in row["results"]:
                if metric.get("engine")!="Docling":
                    continue
                layout=metric["layout_evidence"]
                if row.get("book_id")=="B31":
                    require(layout.get("spatial_alignment") is not None)
                if row.get("book_id")=="B15":
                    require(layout.get("spatial_alignment_status")==
                            "ROTATED_DISPLAY_TRANSFORM_UNVERIFIED")
    else:
        raise PrivateGateError("UNKNOWN_PRIVATE_POLICY")
    return True


def main(argv=None):
    p=argparse.ArgumentParser()
    p.add_argument("--private-input",required=True)
    p.add_argument("--policy",choices=POLICIES,required=True)
    args=p.parse_args(argv)
    try:
        verify(read_private(args.private_input),args.policy)
        print("ACS_PRIVATE_RECEIPT_GATE=PASS")
        print("ACS_PRIVATE_RECEIPT_PRIVACY=NO_PRIVATE_JSON_IN_LOG")
    except Exception:
        # Privacy boundary: even unexpected Python/JSON exceptions must never
        # print traceback, path, text, coordinates, private SHA, or object repr.
        print("ACS_PRIVATE_RECEIPT_GATE=REJECTED")
        sys.exit(2)


if __name__=="__main__":
    main()
