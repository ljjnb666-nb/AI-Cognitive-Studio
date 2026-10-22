#!/usr/bin/env python3
"""Validate an anonymous OCR engine evidence ledger; no accuracy claims."""
import argparse
import json
import math
from pathlib import Path
SOURCE_HEAD = "8388ddbf789e1b97983220a470be1b5e6efe95a8"
RUNS = {"Docling": 39807569923, "PaddleOCR": 39807570076,
        "MinerU Flash": 39807569900, "PyMuPDF": 39807569923}
PAGES = {"B15": ("scanned_statistical_chart", 109),
         "B16": ("native_text", 53),
         "B31": ("scanned_directed_graph", 126)}
ENGINES = {"Docling": "layout_and_ocr", "PaddleOCR": "ocr_text_only",
           "MinerU Flash": "native_text_only", "PyMuPDF": "native_text_only"}
TOP = {"schema_version", "corpus_id", "source_manifest", "source_head_sha",
       "scope", "selection_status", "comparison_policy", "certified_cer",
       "certified_graph_f1", "human_verified", "graph_verified",
       "production_route_changed", "limitations", "observations"}
ROW = {"engine", "engine_role", "book_id", "physical_page", "page_kind",
       "run_id", "source_head_sha", "characters", "wall_ms",
       "native_text_layer_proxy_cer", "interpretation", "spatial_alignment",
       "picture_boxes", "rotation_degrees", "certified_cer",
       "certified_graph_f1", "accuracy_claim", "graph_semantics",
       "human_verified", "graph_verified"}
class GateError(ValueError):
    pass
def need(condition, code):
    if not condition:
        raise GateError(code)
def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0
def validate(data):
    need(type(data) is dict and set(data) == TOP, "INVALID_TOP_LEVEL_SCHEMA")
    need(data["schema_version"] == 1, "SCHEMA_VERSION_INVALID")
    need(data["source_head_sha"] == SOURCE_HEAD, "WRONG_OBSERVED_HEAD")
    need(data["corpus_id"] == "ACS-EBOOK-20261022-A", "CORPUS_MISMATCH")
    need(data["source_manifest"] == "tools/pdf-parser-benchmark/corpus/ebook-20261022.manifest.json", "MANIFEST_MISMATCH")
    need(data["scope"] == "ANONYMOUS_RUN_LOG_METRICS_NOT_REAL_GROUND_TRUTH", "SCOPE_MISMATCH")
    need(data["selection_status"] == "UNDECIDED", "PREMATURE_WINNER")
    need(data["comparison_policy"] == "NO_CROSS_TASK_SPEED_OR_CHARACTER_RANKING", "UNSAFE_RANKING")
    need(data["human_verified"] is False and data["graph_verified"] is False, "FORGED_VERIFICATION")
    need(data["certified_cer"] is None and data["certified_graph_f1"] is None, "FORGED_ACCURACY")
    need(data["production_route_changed"] is False, "PRODUCTION_ROUTE_CHANGED")
    notes = data["limitations"]
    need(type(notes) is list and 1 <= len(notes) <= 16 and all(
         type(s) is str and 0 < len(s) <= 250 and "data:" not in s.lower()
         and "\\" not in s for s in notes), "UNSAFE_NOTES")
    observations = data["observations"]
    need(type(observations) is list and len(observations) == 12, "MISSING_ENGINE_PAGE")
    seen = set()
    for row in observations:
        need(type(row) is dict and set(row) == ROW, "INVALID_OBSERVATION_SCHEMA")
        engine, book = row["engine"], row["book_id"]
        need(engine in ENGINES and book in PAGES, "UNKNOWN_ENGINE_OR_PAGE")
        need((engine, book) not in seen, "DUPLICATE_ENGINE_PAGE")
        seen.add((engine, book))
        kind, physical = PAGES[book]
        need(row["physical_page"] == physical and row["page_kind"] == kind, "PAGE_MISMATCH")
        need(row["source_head_sha"] == SOURCE_HEAD and row["run_id"] == RUNS[engine], "RUN_PROVENANCE_MISMATCH")
        need(row["engine_role"] == ENGINES[engine], "ENGINE_ROLE_MISMATCH")
        need(type(row["characters"]) is int and 0 <= row["characters"] <= 20000, "INVALID_CHAR_COUNT")
        need(number(row["wall_ms"]), "INVALID_LATENCY")
        need(row["accuracy_claim"] == "NOT_ESTABLISHED" and row["graph_semantics"] == "UNVERIFIED", "FORGED_SEMANTICS")
        need(row["certified_cer"] is None and row["certified_graph_f1"] is None, "FORGED_CERTIFIED_SCORE")
        need(row["human_verified"] is False and row["graph_verified"] is False, "FORGED_ROW_AUTHORITY")
        if book == "B16":
            need(row["interpretation"] == "NATIVE_TEXT_PROXY_REFERENCE_ONLY", "INVALID_NATIVE_REFERENCE")
            need(number(row["native_text_layer_proxy_cer"]), "NATIVE_PROXY_MISSING")
        else:
            need(row["native_text_layer_proxy_cer"] is None, "SCANNED_FAKE_CER")
            if engine in ("PyMuPDF", "MinerU Flash"):
                need(row["interpretation"] == "NO_SCANNED_OCR_TESTED" and row["characters"] == 0, "SCANNED_CONTROL_OVERCLAIM")
            else:
                need(row["interpretation"] == "SCANNED_OCR_TEXT_ONLY_NOT_SEMANTICS", "SCANNED_OCR_OVERCLAIM")
        if engine == "Docling" and book in ("B15", "B31"):
            need(row["spatial_alignment"] == "PRIVATE_REFERENCE_UNAVAILABLE", "FALSE_SPATIAL_MATCH")
            need(row["picture_boxes"] == (2 if book == "B15" else 3), "PICTURE_BOX_COUNT")
            need(row["rotation_degrees"] == (270 if book == "B15" else 0), "ROTATION_MISMATCH")
        else:
            need(row["spatial_alignment"] is None, "INVENTED_SPATIAL_EVIDENCE")
    need(len(seen) == 12, "COVERAGE_INCOMPLETE")
    return len(seen)
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("ledger")
    args = parser.parse_args()
    file = Path(args.ledger)
    need(file.is_file() and file.stat().st_size <= 100000, "LEDGER_MISSING_OR_OVERSIZED")
    count = validate(json.loads(file.read_text(encoding="utf-8")))
    print("ACS_EBOOK_EVIDENCE_LEDGER_PASS=" + str(count))
    print("ACS_EBOOK_ENGINE_SELECTION=UNDECIDED")
    print("ACS_EBOOK_CERTIFIED_GRAPH_ACCURACY=UNAVAILABLE")
if __name__ == "__main__":
    main()
