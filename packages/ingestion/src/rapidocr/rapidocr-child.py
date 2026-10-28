#!/usr/bin/env python3
"""Isolated offline OCR worker for an already-authorized PDF page.

Protocol: --probe -> one JSON version/model receipt; --pdf/--page -> exactly one
JSON status+text result. Stderr never goes to public logs. No network/API calls.
The parent owns the temp PDF and enforces process timeout/output budgets.
"""
import argparse
from importlib import metadata, util
import hashlib
import json
import math
import os
from pathlib import Path
import sys

RAPIDOCR="3.9.2"
ONNX="1.22.1"
# RapidOCR 3.9.2's three bundled ONNX weights. Pin actual bytes, not merely
# the wheel version or a runtime-reported self-hash (which cannot detect swaps).
# Upstream v3.9.2 model manifest / release artifact identities.
PINNED_ONNX_SHA256={
    "PP-OCRv6_det_small.onnx":"090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
    "PP-OCRv6_rec_small.onnx":"6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx":"e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
}
# Verified staged PDF files may be up to 200 MiB; the Node legacy byte-input
# executor still separately enforces its existing 110,000,000-byte limit.
MAX_BYTES=200*1024*1024
MAX_PIXELS=8_000_000
MAX_TEXT_CHARS=180_000
# Private runtime diagnostic reports only this allowlisted stage, never source text.
TRACE_STAGE="START"

def output(obj):
    sys.stdout.write(json.dumps(obj,ensure_ascii=False,
                                separators=(",",":"))+"\n")

def verify_pinned_weights(models, expected=None):
    """Fail closed unless the installed bundled model bytes match v3.9.2."""
    expected=PINNED_ONNX_SHA256 if expected is None else expected
    if not models.is_dir() or models.is_symlink():
        raise RuntimeError("OCR_WEIGHTS_MISSING")
    found={p.name:p for p in models.glob("*.onnx")}
    # Also reject extra weights: the returned fingerprint must describe the
    # complete, fixed set rather than merely two arbitrary files.
    if set(found)!=set(expected):
        raise RuntimeError("OCR_WEIGHTS_SET_MISMATCH")
    aggregate=hashlib.sha256()
    for name in sorted(expected):
        path=found[name]
        if not path.is_file() or path.is_symlink():
            raise RuntimeError("OCR_WEIGHTS_INVALID")
        size=path.stat().st_size
        if not 10_000<size<=150_000_000:
            raise RuntimeError("OCR_WEIGHTS_INVALID")
        digest=hashlib.sha256()
        aggregate.update(name.encode("utf-8"))
        with path.open("rb") as f:
            for part in iter(lambda:f.read(1024*1024),b""):
                digest.update(part)
                aggregate.update(part)
        if digest.hexdigest()!=expected[name]:
            raise RuntimeError("OCR_WEIGHTS_SHA_MISMATCH")
    return aggregate.hexdigest()


def check_runtime():
    # A valid OCR wheel alone cannot process a PDF. Probe the actual rasterizer
    # and ndarray modules before worker startup instead of failing per page.
    import fitz  # noqa: F401
    import numpy  # noqa: F401
    if metadata.version("rapidocr")!=RAPIDOCR or metadata.version("onnxruntime")!=ONNX:
        raise RuntimeError("OCR_VERSION_MISMATCH")
    spec=util.find_spec("rapidocr")
    if spec is None or spec.origin is None:
        raise RuntimeError("OCR_MODULE_MISSING")
    return verify_pinned_weights(Path(spec.origin).resolve().parent/"models")

def validate_source_file(path):
    # Defense-in-depth for both the verified-file and legacy temporary paths.
    # The SHA/size authority remains the parent Worker source staging fence.
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("OCR_INPUT_INVALID")
    size=path.stat().st_size
    if not 5<=size<=MAX_BYTES:
        raise RuntimeError("OCR_INPUT_INVALID")
    with path.open("rb") as source:
        if source.read(5)!=b"%PDF-":
            raise RuntimeError("OCR_INPUT_INVALID")


def extract(path,page):
    global TRACE_STAGE
    TRACE_STAGE="SOURCE_INPUT"
    validate_source_file(path)
    TRACE_STAGE="IMPORT_RASTER_AND_OCR"
    import fitz
    import numpy as np
    from rapidocr import RapidOCR
    TRACE_STAGE="RENDER_PDF_PAGE"
    with fitz.open(path) as pdf:
        if pdf.needs_pass or page<0 or page>=pdf.page_count:
            raise RuntimeError("OCR_PAGE_INVALID")
        # Fail before allocating excessively large bitmaps.
        rectangle=pdf[page].rect
        width=math.ceil(rectangle.width*1.6)
        height=math.ceil(rectangle.height*1.6)
        if width<1 or height<1 or width*height>MAX_PIXELS:
            raise RuntimeError("OCR_IMAGE_BUDGET_EXCEEDED")
        pix=pdf[page].get_pixmap(matrix=fitz.Matrix(1.6,1.6),
                                 colorspace=fitz.csRGB,alpha=False)
        if pix.width*pix.height>MAX_PIXELS:
            raise RuntimeError("OCR_IMAGE_BUDGET_EXCEEDED")
        rgb=np.frombuffer(pix.samples,dtype=np.uint8).reshape(
            pix.height,pix.width,3)
        # The benchmark RapidOCR 3.9.2 accepts BGR ndarray.
        bgr=rgb[:,:,::-1].copy()
    TRACE_STAGE="RAPIDOCR_INFERENCE"
    result=RapidOCR()(bgr)
    TRACE_STAGE="RAPIDOCR_RESULT_SCHEMA"
    if result is None:
        raise RuntimeError("OCR_RESULT_MISSING")
    txts=getattr(result,"txts",None)
    boxes=getattr(result,"boxes",None)
    scores=getattr(result,"scores",None)
    if txts is None and boxes is None and scores is None:
        return ""
    if any(x is None for x in (txts,boxes,scores)) or not(
            len(txts)==len(boxes)==len(scores)):
        raise RuntimeError("OCR_RESULT_INVALID")
    rows=[]
    for t,s in zip(txts,scores):
        if not isinstance(t,str) or len(t)>10000 or not math.isfinite(float(s)):
            raise RuntimeError("OCR_RESULT_INVALID")
        if t.strip():
            rows.append(t.strip())
    text="\n".join(rows)
    if len(text)>MAX_TEXT_CHARS:
        raise RuntimeError("OCR_RESULT_TOO_LARGE")
    return text

def main():
    arg=argparse.ArgumentParser()
    mode=arg.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe",action="store_true")
    mode.add_argument("--pdf")
    arg.add_argument("--page",type=int)
    arg.add_argument("--safe-diagnostic-stage",action="store_true")
    opts=arg.parse_args()
    os.environ["HF_HUB_OFFLINE"]="1"
    os.environ["TRANSFORMERS_OFFLINE"]="1"
    try:
        digest=check_runtime()
        if opts.probe:
            output({"schemaVersion":1,"status":"READY","rapidocr":RAPIDOCR,
                    "onnxruntime":ONNX,"modelSha256":digest})
            return 0
        if opts.page is None or opts.page<0:
            raise RuntimeError("OCR_PAGE_INVALID")
        result=extract(Path(opts.pdf),opts.page)
        output({"schemaVersion":1,"status":"SUCCEEDED","text":result})
        return 0
    except Exception:
        # Do not reveal original text/paths/exception details, even for private
        # synthetic smoke. Normal production protocol remains unchanged.
        record={"schemaVersion":1,"status":"FAILED"}
        if opts.safe_diagnostic_stage:
            record["safeStage"]=TRACE_STAGE
        output(record)
        return 2

if __name__=="__main__":
    sys.exit(main())
