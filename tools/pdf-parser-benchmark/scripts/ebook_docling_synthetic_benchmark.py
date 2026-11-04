#!/usr/bin/env python3
"""Real Docling vs known-truth synthetic Chinese scanned PDF; no private corpus."""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import time

from rapidfuzz.distance.Levenshtein import distance

from ebook_synthetic_column_truth import CLEAN, COLUMNS, locate_font, normalize, render


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--output", required=True)
    cli.add_argument("--font-path", default=None)
    args = cli.parse_args()

    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TesseractCliOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    import docling
    import importlib.metadata

    options = PdfPipelineOptions()
    options.do_ocr = True
    options.do_table_structure = False
    options.ocr_options = TesseractCliOcrOptions(lang=["chi_sim", "eng"])
    converter = DocumentConverter(format_options={
        InputFormat.PDF: PdfFormatOption(pipeline_options=options)
    })
    images = render(locate_font(args.font_path))
    rows = []
    with tempfile.TemporaryDirectory(prefix="acs-docling-synthetic-") as temp:
        for label, image, truth in zip(("clean_text", "two_columns"), images, (CLEAN, COLUMNS)):
            pdf = Path(temp) / (label + ".pdf")
            image.save(pdf, "PDF", resolution=150)
            started = time.perf_counter()
            result = converter.convert(pdf, raises_on_error=True, max_num_pages=1)
            out = normalize(result.document.export_to_markdown())
            expected = normalize("".join(truth))
            dist = distance(expected, out)
            rows.append({
                "case": label, "reference_characters": len(expected),
                "recognized_characters": len(out), "edit_distance": dist,
                "cer": round(dist / len(expected), 4),
                "wall_ms": round((time.perf_counter() - started) * 1000, 1),
                "input_pdf_sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
            })
            print(f"ACS_DOCLING_SYNTHETIC_CASE={label} CER={rows[-1]['cer']} "
                  f"WALL_MS={rows[-1]['wall_ms']}", flush=True)
    report = {
        "schema_version": 1,
        "evidence_level": "L3_AUTHOR_GENERATED_SYNTHETIC_TRUTH",
        "candidate": "Docling standard PDF pipeline + TesseractCliOcrOptions(chi_sim,eng)",
        "version": importlib.metadata.version("docling"),
        "comparison_limitations": [
            "Docling and Tesseract share the same OCR engine; only document layout/reading-order differs",
            "Synthetic clean text and two-column image PDF, not real private book",
            "CER based on normalized alphanumeric/CJK text; Markdown structure not independently scored",
            "Startup and model initialisation included in first page wall time, not steady-state throughput",
        ],
        "rows": rows,
    }
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if len(rows) != 2:
        raise RuntimeError("Missing synthetic page result")


if __name__ == "__main__":
    main()
