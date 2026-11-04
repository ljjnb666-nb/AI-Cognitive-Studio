#!/usr/bin/env python3
"""Local (not cloud API) PaddleOCR PP-OCR known-truth layout ablation; synthetic only."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import time
import numpy as np
from rapidfuzz.distance.Levenshtein import distance
from ebook_synthetic_column_truth import CLEAN, COLUMNS, locate_font, normalize, render


def predict(ocr, image):
    result = ocr.predict(input=np.asarray(image))
    texts = []
    for item in result:
        data = item.json
        if callable(data):
            data = data()
        if "res" in data:
            data = data["res"]
        recognized = data.get("rec_texts", [])
        if not isinstance(recognized, list):
            raise TypeError("PaddleOCR: rec_texts was not a list")
        texts.extend(str(value) for value in recognized)
    return normalize("".join(texts))


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--output", required=True)
    cli.add_argument("--font-path", default=None)
    args = cli.parse_args()
    from paddleocr import PaddleOCR

    started_init = time.perf_counter()
    ocr = PaddleOCR(lang="ch", use_doc_orientation_classify=False,
                    use_doc_unwarping=False, use_textline_orientation=False,
                    engine="paddle", device="cpu")
    init_ms = round((time.perf_counter() - started_init) * 1000, 1)
    clean, columns = render(locate_font(args.font_path))
    rows = []
    for name, image, source in (
            ("clean_text", clean, CLEAN),
            ("two_columns_whole", columns, COLUMNS)):
        expected = normalize("".join(source))
        t = time.perf_counter()
        output = predict(ocr, image)
        ms = round((time.perf_counter() - t) * 1000, 1)
        rows.append({"case": name, "reference_characters": len(expected),
                     "recognized_characters": len(output),
                     "edit_distance": distance(expected, output),
                     "cer": round(distance(expected, output) / len(expected), 4),
                     "inference_wall_ms": ms})
    t = time.perf_counter()
    out = "".join(predict(ocr, columns.crop(bounds)) for bounds in
                  ((0, 0, 620, 1754), (620, 0, 1240, 1754)))
    expected = normalize("".join(COLUMNS))
    rows.append({"case": "two_columns_split", "reference_characters": len(expected),
                 "recognized_characters": len(out),
                 "edit_distance": distance(expected, out),
                 "cer": round(distance(expected, out) / len(expected), 4),
                 "inference_wall_ms": round((time.perf_counter() - t) * 1000, 1)})
    report = {"schema_version": 1, "evidence_level": "L3_AUTHORED_SYNTHETIC_TRUTH",
              "candidate": "PaddleOCR local PP-OCR engine=paddle device=cpu",
              "version": importlib.metadata.version("paddleocr"),
              "init_wall_ms": init_ms, "rows": rows,
              "limits": ["No PP-StructureV3 model: text OCR only; no table/formula/graph score",
                         "Synthetic image tests only; real private books not benchmarked",
                         "Recognition text order determined by PaddleOCR output; cropped reading order is supplied externally",
                         "CPU inference and first-model-download cost must be measured separately"]}
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
    for row in rows:
        print(f"ACS_PADDLE_SYNTHETIC_CASE={row['case']} CER={row['cer']} "
              f"WALL_MS={row['inference_wall_ms']}", flush=True)


if __name__ == "__main__":
    main()
