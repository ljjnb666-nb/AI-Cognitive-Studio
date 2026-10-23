#!/usr/bin/env python3
"""SHA-pinned private Windows Docling evaluation; no book text/images are exported."""
import argparse
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
from ebook_private_roi_alignment import docling_picture_boxes, geometry_gate, match as align_private_roi
from ebook_roi_rotation_contract import calibrated_match
from ebook_layout_signals import docling_layout_signals
import re
import shutil
import subprocess
import tempfile
import time
import zipfile

PAGES = {"B16": 53, "B15": 109, "B31": 126}
MAX_BYTES = 200 * 1024 * 1024


def normalized(s):
    return "".join(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]+", s)).lower()


def inputs(root):
    for path in Path(root).rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        if path.suffix.lower() == ".pdf" and path.stat().st_size <= MAX_BYTES:
            yield path.read_bytes()
        elif path.suffix.lower() == ".zip":
            try:
                with zipfile.ZipFile(path) as z:
                    for member in z.infolist():
                        if (member.is_dir() or member.file_size > MAX_BYTES
                                or not member.filename.lower().endswith(".pdf")):
                            continue
                        with z.open(member) as stream:
                            data = stream.read(MAX_BYTES + 1)
                        if len(data) <= MAX_BYTES:
                            yield data
            except (OSError, zipfile.BadZipFile):
                continue


def edit_distance(a, b):
    """Exact Levenshtein distance using bounded linear workspace."""
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, char_a in enumerate(a, 1):
        row = [i]
        for j, char_b in enumerate(b, 1):
            row.append(min(row[j - 1] + 1, prev[j] + 1,
                           prev[j - 1] + (char_a != char_b)))
        prev = row
    return prev[-1]


def compact(engine, output, elapsed):
    value = normalized(output)
    return {"engine": engine, "wall_ms": round(elapsed * 1000, 1),
            "characters": len(value),
            "content_sha256": hashlib.sha256(value.encode("utf-8")).hexdigest()}


def evaluate(fixture, source, converter, private_reference=None, private_frame_calibration=None):
    import fitz
    from docling.datamodel.base_models import ConversionStatus
    physical = PAGES[fixture["id"]]
    with fitz.open(stream=source, filetype="pdf") as doc:
        if len(doc) != fixture["total_physical_pages"]:
            raise ValueError("physical page count mismatch")
        page = doc[physical - 1]
        pdf_page_rotation = int(page.rotation)
        started = time.perf_counter()
        native_text = page.get_text("text", sort=True)
        native_reference = normalized(native_text)
        simple = compact("PyMuPDF", native_text, time.perf_counter() - started)
        single = fitz.open()
        single.insert_pdf(doc, from_page=physical - 1, to_page=physical - 1)
        one_page = single.tobytes()
        single.close()
        tesseract_available = bool(shutil.which("tesseract"))
        if tesseract_available:
            image = page.get_pixmap(matrix=fitz.Matrix(1.6, 1.6),
                                    colorspace=fitz.csRGB, alpha=False).tobytes("png")
    rows = [simple]
    if tesseract_available:
        started = time.perf_counter()
        result = subprocess.run(["tesseract", "stdin", "stdout", "-l", "chi_sim+eng", "--psm", "3"],
                                input=image, capture_output=True, check=True, timeout=90)
        rows.append(compact("Tesseract-PSM3", result.stdout.decode("utf-8", "replace"),
                            time.perf_counter() - started))
        del image
    else:
        rows.append({"engine": "Tesseract-PSM3", "status": "NOT_INSTALLED"})
    with tempfile.TemporaryDirectory(prefix="acs-docling-") as tmp:
        path = Path(tmp) / f'{fixture["id"]}_p{physical}.pdf'
        path.write_bytes(one_page)
        del one_page
        started = time.perf_counter()
        result = converter.convert(path, raises_on_error=True, max_num_pages=1)
        duration = time.perf_counter() - started
        if result.status != ConversionStatus.SUCCESS:
            raise RuntimeError("Docling status: " + str(result.status))
        recognized = normalized(result.document.export_to_markdown())
        docling_metric = compact("Docling", recognized, duration)
        docling_metric["layout_evidence"] = docling_layout_signals(result.document)
        # Private report only: independently establish whether Docling's
        # document page coordinates are unrotated or displayed. Never select
        # this frame by trying to maximize overlap with AI reference ROIs.
        page_size = result.document.pages[1].size
        docling_metric["layout_evidence"]["private_docling_page_size"] = [
            float(page_size.width), float(page_size.height),
        ]
        # Actual bounding boxes stay in the private D: report, never Actions stdout.
        picture_boxes = docling_picture_boxes(result.document)
        docling_metric["layout_evidence"]["private_picture_boxes_normalized"] = [
            list(box) for box in picture_boxes]
        docling_metric["layout_evidence"]["picture_boxes_with_geometry"] = len(picture_boxes)
        docling_metric["layout_evidence"]["source_pdf_rotation_degrees"] = pdf_page_rotation
        status = geometry_gate(fixture["id"], docling_metric["layout_evidence"]["picture_items"], picture_boxes, pdf_page_rotation, private_reference is not None)
        docling_metric["layout_evidence"]["spatial_alignment_status"] = status
        if (status == "PRIVATE_REFERENCE_READY_TO_MATCH" or
                (status == "ROTATED_DISPLAY_TRANSFORM_UNVERIFIED" and
                 fixture["id"] == "B15" and private_frame_calibration is not None)) and fixture["id"] in ("B15", "B31"):
            candidate = {
                "schema_version": 1,
                "book_id": fixture["id"],
                "physical_page": physical,
                "source_document_sha256": fixture["sha256"],
                "engine": "Docling",
                "picture_boxes_normalized": [list(box) for box in picture_boxes],
            }
            alignment = (calibrated_match(private_reference, candidate, private_frame_calibration, pdf_page_rotation)
                         if status == "ROTATED_DISPLAY_TRANSFORM_UNVERIFIED"
                         else align_private_roi(private_reference, candidate))
            docling_metric["layout_evidence"]["spatial_alignment"] = alignment
            docling_metric["layout_evidence"]["spatial_alignment_status"] = alignment["status"]
        if native_reference:
            docling_metric["native_reference_edit_distance"] = edit_distance(native_reference, recognized)
            docling_metric["native_reference_cer"] = round(
                docling_metric["native_reference_edit_distance"] / len(native_reference), 4)
            docling_metric["reference_quality"] = "NATIVE_PDF_TEXT_LAYER_PROXY_NOT_GROUND_TRUTH"
        rows.append(docling_metric)
    return {"book_id": fixture["id"], "physical_page": physical,
            "source_sha256": fixture["sha256"], "results": rows,
            "docling_status": "SUCCESS"}


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--root", required=True)
    cli.add_argument("--manifest", required=True)
    cli.add_argument("--output", required=True)
    args = cli.parse_args()
    corpus = json.loads(Path(args.manifest).read_text("utf-8"))
    expected = {entry["sha256"]: entry for entry in corpus["sources"]
                if entry["id"] in PAGES}
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TesseractCliOcrOptions, RapidOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    ocr_kind = ("TesseractCliOcrOptions" if shutil.which("tesseract")
                else "RapidOcrOptions")
    opts = PdfPipelineOptions()
    opts.do_ocr = True
    opts.do_table_structure = False
    opts.ocr_options = (TesseractCliOcrOptions(lang=["chi_sim", "eng"])
                        if shutil.which("tesseract") else RapidOcrOptions())
    pipeline = DocumentConverter(format_options={InputFormat.PDF:
                                 PdfFormatOption(pipeline_options=opts)})
    # Optional L2 reference is local-only. Its absence never becomes a fabricated miss.
    roi_path = Path(args.root) / "semantic_gate" / "B15_B31_roi_candidates.private.json"
    private_reference = None
    if roi_path.is_file():
        if roi_path.is_symlink() or roi_path.stat().st_size > 262144:
            raise ValueError("Private ROI reference unsafe or oversized")
        private_reference = json.loads(roi_path.read_text(encoding="utf-8"))
    # Optional: three independently marked private page anchors must prove the
    # Docling-to-PDF-display frame before B15 rotation alignment. Never infer
    # the frame from a tool name or rotated source PDF metadata alone.
    calibration_path = Path(args.root) / "semantic_gate" / "B15_roi_frame_calibration.private.json"
    private_frame_calibration = None
    if calibration_path.is_file():
        if calibration_path.is_symlink() or calibration_path.stat().st_size > 262144:
            raise ValueError("Private frame calibration unsafe or oversized")
        private_frame_calibration = json.loads(calibration_path.read_text(encoding="utf-8"))
    results = {}
    for raw in inputs(args.root):
        fixture = expected.get(hashlib.sha256(raw).hexdigest())
        if fixture is None or fixture["id"] in results:
            continue
        if len(raw) != fixture["size"]:
            raise ValueError("SHA-selected length mismatch")
        try:
            results[fixture["id"]] = {
                "status": "SUCCESS",
                **evaluate(fixture, raw, pipeline, private_reference, private_frame_calibration),
            }
            print("ACS_DOCLING_REAL_BOOK_COMPLETE=" + fixture["id"], flush=True)
        except Exception as exc:
            results[fixture["id"]] = {
                "status": "FAILURE",
                "book_id": fixture["id"],
                "physical_page": PAGES[fixture["id"]],
                "error_type": type(exc).__name__,
            }
            print("ACS_DOCLING_REAL_BOOK_FAILED=" + fixture["id"]
                  + ":" + type(exc).__name__, flush=True)
        del raw
    missing = sorted(set(PAGES).difference(results))
    failed = sorted(k for k, val in results.items() if val["status"] != "SUCCESS")
    report = {"schema_version": 1, "corpus_id": corpus["corpus_id"],
              "evidence_level": "L0_L1_REAL_PRIVATE_PAGES_NOT_ACCURACY",
              "docling_version": importlib.metadata.version("docling"),
              "docling_ocr_backend": ocr_kind, "books": sorted(results),
              "missing": missing, "failed": failed, "rows": [results[k] for k in sorted(results)],
              "limits": ["No CER without independent real-page ground truth",
                         "Docling text alone does not verify chart/graph semantics",
                         "No book text or images exported"]}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    staging = output.with_suffix(".tmp")
    staging.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
    staging.replace(output)
    if missing or failed:
        raise SystemExit("REAL_BENCHMARK_INCOMPLETE missing="
                         + ",".join(missing) + " failed=" + ",".join(failed))
    print("ACS_DOCLING_REAL_PRIVATE_PASS=" + str(len(results)), flush=True)


if __name__ == "__main__":
    main()
