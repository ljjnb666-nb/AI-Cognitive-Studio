#!/usr/bin/env python3
"""Reproducible synthetic Chinese OCR reading-order benchmark. No copyrighted input."""
import argparse
import hashlib
from io import BytesIO
import json
import re
import shutil
import subprocess
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from rapidfuzz.distance.Levenshtein import distance

CLEAN = [
    "人工智能系统可以把一本书转化为结构化知识。",
    "文档解析需要同时考虑文字、图片、表格和公式。",
    "如果只根据文字数量评价结果，容易忽略阅读顺序。",
    "稳定的工具链应当记录来源、页码和处理版本。",
    "测试样本在每次运行前都必须验证SHA256摘要。",
    "遇到无法确认的内容，系统应该保留不确定状态。",
    "同一张页面上的文字和图像应当保留关联关系。",
    "目标是优先找到成本合理且可靠的多工具组合。",
]
COLUMNS = [
    "左列第一段介绍文档结构。",
    "左列第二段讨论文本提取。",
    "左列第三段记录来源信息。",
    "左列第四段分析识别错误。",
    "右列第一段介绍图表识别。",
    "右列第二段讨论公式结构。",
    "右列第三段设计质量门禁。",
    "右列第四段验证系统性能。",
]


def locate_font(requested):
    candidates = [requested, "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simsun.ttc",
                  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    if shutil.which("fc-match"):
        chosen = subprocess.check_output(["fc-match", "-f", "%{file}", "Noto Sans CJK SC"],
                                         timeout=10).decode("utf-8")
        if Path(chosen).is_file():
            return chosen
    raise RuntimeError("CJK font missing; specify --font-path")


def normalize(text):
    return "".join(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]+", text)).lower()


def render(font_path):
    base = ImageFont.truetype(font_path, 34)
    small = ImageFont.truetype(font_path, 25)
    clean = Image.new("RGB", (1240, 1754), "white")
    paint = ImageDraw.Draw(clean)
    for index, text in enumerate(CLEAN):
        paint.text((75, 130 + index * 120), text, fill="black", font=base)
    columns = Image.new("RGB", (1240, 1754), "white")
    paint = ImageDraw.Draw(columns)
    for index, text in enumerate(COLUMNS):
        col = 0 if index < 4 else 1
        paint.text((70 + col * 605, 150 + (index % 4) * 130),
                   text, fill="black", font=small)
    return clean, columns


def to_png(image):
    out = BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


def recognize(image, mode):
    png = to_png(image)
    started = time.perf_counter()
    run = subprocess.run(["tesseract", "stdin", "stdout", "-l", "chi_sim+eng",
                          "--psm", str(mode)], input=png, capture_output=True, timeout=30)
    if run.returncode:
        raise RuntimeError(f"Tesseract mode {mode} failed with code {run.returncode}")
    return normalize(run.stdout.decode("utf-8", "replace")), round(
        (time.perf_counter() - started) * 1000, 1)


def evaluate(label, expected, got, ms, image_bytes_sha):
    dist = distance(expected, got)
    return {"case": label, "reference_characters": len(expected),
            "recognized_characters": len(got), "edit_distance": dist,
            "cer": round(dist / len(expected), 4), "execution_ms": ms,
            "image_sha256": image_bytes_sha}


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--font-path", default=None)
    cli.add_argument("--output", required=True)
    cli.add_argument("--max-column-cer", type=float, default=0.10)
    args = cli.parse_args()
    if not shutil.which("tesseract"):
        raise RuntimeError("Tesseract binary missing")
    clean, columns = render(locate_font(args.font_path))
    rows = []
    for name, image, source in [("clean_text", clean, CLEAN),
                                 ("two_columns", columns, COLUMNS)]:
        ref = normalize("".join(source))
        sha = hashlib.sha256(to_png(image)).hexdigest()
        for psm in (3, 6, 11):
            actual, elapsed = recognize(image, psm)
            rows.append(evaluate(f"{name}_psm{psm}", ref, actual, elapsed, sha))
    ref = normalize("".join(COLUMNS))
    split_text = []
    elapsed = 0
    for x1, x2 in ((0, 620), (620, 1240)):
        actual, ms = recognize(columns.crop((x1, 0, x2, 1754)), 6)
        split_text.append(actual)
        elapsed += ms
    split = evaluate("two_columns_split_psm6", ref, "".join(split_text),
                     round(elapsed, 1), hashlib.sha256(to_png(columns)).hexdigest())
    rows.append(split)
    full = next(row for row in rows if row["case"] == "two_columns_psm6")
    report = {
        "schema_version": 1,
        "evidence_level": "L3_SYNTHETIC_AUTHORED_REFERENCE_NOT_REAL_BOOK_ACCURACY",
        "truth_source": "Deterministically authored Chinese strings in this script",
        "normalization": "Chinese + ASCII alphanumeric; spaces/punctuation excluded",
        "engine": "Tesseract chi_sim+eng",
        "rows": rows,
        "improvement": {"whole_page_cer": full["cer"], "column_first_cer": split["cer"],
                        "absolute_cer_reduction": round(full["cer"] - split["cer"], 4)},
    }
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["improvement"], ensure_ascii=False))
    if not (split["cer"] <= args.max_column_cer and split["cer"] < full["cer"]):
        raise SystemExit("FAIL: column-aware OCR gate was not satisfied")


if __name__ == "__main__":
    main()
