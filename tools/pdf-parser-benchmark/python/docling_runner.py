"""Docling benchmark runner.

Runs the official Docling DocumentConverter with default pipeline options and
serializes a page-structured result JSON for the harness. This script only
reads its input and writes to the paths the harness passes; model downloads
are directed to the D: cache by harness-provided environment (HF_HOME etc.).

Usage: docling_runner.py <input.pdf> <result.json> <markdown-out.md> <page-cap|all> [native|ocr]

The optional 5th argument selects the OCR policy explicitly: "native" forces
do_ocr=False, "ocr" forces do_ocr=True with the configured default backend.
The effective values are reported in the payload (facts, never guesses).
"""
from __future__ import annotations

import importlib.metadata
import json
import sys
from pathlib import Path


def kind_for_item(item) -> str:
    label = str(getattr(item, "label", "") or "")
    mapping = {
        "TITLE": "heading",
        "SECTION_HEADER": "heading",
        "TEXT": "paragraph",
        "PARAGRAPH": "paragraph",
        "LIST_ITEM": "list_item",
        "TABLE": "table",
        "PICTURE": "figure",
        "FORMULA": "equation",
        "CODE": "code",
        "CAPTION": "caption",
        "FOOTNOTE": "footnote",
        "PAGE_HEADER": "page-header",
        "PAGE_FOOTER": "page-footer",
    }
    return mapping.get(label, label.lower().replace(" ", "-") or "unknown")


def text_for_item(item, doc) -> str:
    try:
        if getattr(item, "label", "") == "TABLE" and hasattr(item, "export_to_markdown"):
            return item.export_to_markdown(doc=doc)
    except Exception:  # noqa: BLE001 - keep raw text fallback
        pass
    return str(getattr(item, "text", "") or "")


def main() -> int:
    input_pdf, result_path, markdown_path, page_cap = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    ocr_policy = sys.argv[5] if len(sys.argv) > 5 else "native"
    if ocr_policy not in ("native", "ocr"):
        raise ValueError(f"invalid ocr policy: {ocr_policy}")

    from docling.document_converter import DocumentConverter, PdfFormatOption, InputFormat
    # docling 2.129: pipeline options live under docling.datamodel (the
    # datapipeline module no longer exists; NativePdfPipelineOptions has no
    # OCR fields). Default do_ocr is True — explicit construction is what
    # keeps native/OCR mode separation honest.
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    version = importlib.metadata.version("docling")
    pipeline_options = PdfPipelineOptions()
    pipeline_options.do_ocr = ocr_policy == "ocr"
    do_ocr = bool(pipeline_options.do_ocr)
    ocr_backend = None
    ocr_language = None
    try:
        backend = getattr(pipeline_options, "ocr_options", None)
        if backend is not None:
            kind = getattr(backend, "kind", backend)
            ocr_backend = str(kind.value) if hasattr(kind, "value") else type(kind).__name__
            lang = getattr(backend, "lang", None)
            if isinstance(lang, (list, tuple)):
                ocr_language = ",".join(str(item) for item in lang)
            elif lang is not None:
                ocr_language = str(lang)
    except Exception:  # noqa: BLE001 - options introspection is best-effort
        pass
    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)}
    )

    cap = None if page_cap == "all" else int(page_cap)
    convert_result = None
    ranged = False
    try:
        if cap is not None:
            # docling page ranges are 1-based: start must be >= 1 (a 0 start
            # raises a pydantic ValidationError, not a TypeError).
            convert_result = converter.convert(Path(input_pdf), page_range=(1, max(cap, 1)))
            ranged = True
        else:
            convert_result = converter.convert(Path(input_pdf))
    except TypeError:
        # installed docling without page_range support — convert everything
        convert_result = converter.convert(Path(input_pdf))

    doc = convert_result.document
    pages: dict[int, list] = {}
    for item, _level in doc.iterate_items():
        provs = list(getattr(item, "prov", []) or [])
        page_no = None
        bbox = None
        if provs:
            page_no = int(provs[0].page_no) - 1
            raw_bbox = getattr(provs[0], "bbox", None)
            if raw_bbox is not None:
                try:
                    bbox = {"x0": float(raw_bbox.left), "y0": float(raw_bbox.top), "x1": float(raw_bbox.right), "y1": float(raw_bbox.bottom)}
                except Exception:  # noqa: BLE001
                    bbox = None
        kind = kind_for_item(item)
        text = text_for_item(item, doc)
        entry = {
            "kind": kind,
            "text": text,
            "pageIndex": page_no,
            "bbox": bbox,
            "confidence": None,
            "sourceMethod": "native-model-pipeline",
        }
        pages.setdefault(page_no if page_no is not None else 0, []).append(entry)

    markdown = doc.export_to_markdown()
    Path(markdown_path).write_text(markdown, encoding="utf-8")

    payload = {
        "ok": True,
        "doclingVersion": version,
        "ocrRequested": ocr_policy == "ocr",
        "doOcr": do_ocr,
        "ocrBackend": ocr_backend,
        "ocrLanguage": ocr_language,
        "pageRangeApplied": ranged,
        "pages": [{"pageIndex": index, "printedPageLabel": None, "blocks": blocks} for index, blocks in sorted(pages.items())],
    }
    Path(result_path).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - report any failure through the result file
        import traceback

        Path(sys.argv[2]).write_text(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}", "trace": traceback.format_exc()[-4000:]}), encoding="utf-8")
        raise
