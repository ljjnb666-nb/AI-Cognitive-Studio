"""Private, evidence-only OpenCV geometry candidates for MinerU page rasters.

Outputs boxes/segments/possible arrow tips with original PNG pixel coordinates.
It does NOT identify graph nodes, graph edges, semantic arrow directions or
timelines, and does not transmit private screenshots or text to GitHub.
Requires preinstalled cv2 and Pillow, only imported in execute().
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys
from pathlib import Path

DATA_ROOT = Path(r"D:\ai-cognitive-pdf-benchmark-data")
SOURCE_RUN = "real-mineru-39440805765-1"
ALLOWED = {
    "RB-PDF-12": [73, 145, 261],
    "RB-PDF-13": [51, 127, 379],
}
MAX_PNG_BYTES = 20_000_000
MAX_IMAGE_PIXELS = 32_000_000
MAX_LINES = 120
MAX_BOXES = 80
MAX_TIPS = 40
MAX_CONTOURS = 100_000


class CandidateBlocked(ValueError):
    pass


def safe_dir(path: Path) -> None:
    if (path.is_symlink() or getattr(path, "is_junction", lambda: False)()
            or not path.is_dir()):
        raise CandidateBlocked("UNSAFE_DIRECTORY")


def sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for data in iter(lambda: f.read(1 << 20), b""):
            h.update(data)
    return h.hexdigest()


def regular(path: Path, limit: int) -> bool:
    return (not path.is_symlink()
            and not getattr(path, "is_junction", lambda: False)()
            and path.is_file() and 0 < path.stat().st_size <= limit)


def validate_evidence(root: Path, fixture: str) -> list[dict]:
    """Never trust paths or structure inferred from OCR text or doc: references."""
    if fixture not in ALLOWED:
        raise CandidateBlocked("FIXTURE_NOT_ALLOWLISTED")
    safe_dir(root)
    fixture_dir = root / "fixtures"
    reports = root / "reports"
    run = reports / SOURCE_RUN
    base = run / ("figure-evidence-v1-" + fixture)
    for folder in (fixture_dir, reports, run, base, base / "pages"):
        safe_dir(folder)
    evidence_file = base / "figure-evidence.json"
    if not regular(evidence_file, 524_288):
        raise CandidateBlocked("FIGURE_MANIFEST_MISSING")
    try:
        record = json.loads(evidence_file.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError):
        raise CandidateBlocked("FIGURE_MANIFEST_INVALID") from None
    if (record.get("schemaVersion") != "acs-mineru-figure-page-evidence-v1"
            or record.get("fixtureId") != fixture
            or record.get("sourceRun") != SOURCE_RUN
            or record.get("sourcePages1Based") != ALLOWED[fixture]
            or record.get("claim") != "PERSISTED_FULL_PAGE_VISUAL_FALLBACK_ONLY"
            or record.get("noCroppedFigureOrDiagramRelationshipClaim") is not True):
        raise CandidateBlocked("FIGURE_MANIFEST_IDENTITY_MISMATCH")
    pdf = fixture_dir / (fixture + ".pdf")
    md = run / (fixture + ".md")
    if not regular(pdf, 200_000_000) or not regular(md, 12_000_000):
        raise CandidateBlocked("SOURCE_NOT_READY")
    if (sha_file(pdf) != record.get("sourceSubsetSha256")
            or sha_file(md) != record.get("sourceMarkdownSha256")):
        raise CandidateBlocked("SOURCE_CHECKSUM_MISMATCH")
    images = record.get("images")
    if not isinstance(images, list) or not (1 <= len(images) <= 3):
        raise CandidateBlocked("UNEXPECTED_IMAGE_COUNT")
    pages = []
    seen = set()
    for im in images:
        if not isinstance(im, dict):
            raise CandidateBlocked("INVALID_IMAGE_ROW")
        idx = im.get("subsetPageIndex")
        phy = im.get("sourcePhysicalPage1Based")
        if (type(idx) is not int or idx < 0 or idx >= 3
                or idx in seen or phy != ALLOWED[fixture][idx]):
            raise CandidateBlocked("PAGE_PROVENANCE_MISMATCH")
        seen.add(idx)
        name = im.get("relativeImagePath")
        if name != f"pages/page-{idx+1:03d}.png":
            raise CandidateBlocked("UNSAFE_IMAGE_RELATIVE_PATH")
        path = base / name
        if not regular(path, MAX_PNG_BYTES) or path.stat().st_size != im.get("imageBytes"):
            raise CandidateBlocked("IMAGE_MISSING_OR_ALTERED")
        if sha_file(path) != im.get("imageSha256"):
            raise CandidateBlocked("IMAGE_DIGEST_MISMATCH")
        width, height = im.get("widthPixels"), im.get("heightPixels")
        if (type(width) is not int or type(height) is not int
                or not (1 <= width <= 8192 and 1 <= height <= 8192)
                or width * height > MAX_IMAGE_PIXELS):
            raise CandidateBlocked("IMAGE_DIMENSION_INVALID")
        refs = im.get("sourceFigureBlockRefs")
        if (not isinstance(refs, list) or not refs or len(refs) > 100
                or len(refs) != len(set(refs))
                or not all(isinstance(v, str) and
                           re.fullmatch(r"doc:[0-9a-f]{6,64}/tier:flash/page:[1-3]/block:[1-9][0-9]{0,5}", v)
                           for v in refs)):
            raise CandidateBlocked("INVALID_FIGURE_REF")
        if (im.get("graphSemantics") != "NOT_VERIFIED"
                or im.get("figureRegionBounds") is not None
                or im.get("diagramEdges") is not None
                or im.get("regionType") != "FULL_PAGE_UNCROPPED"):
            raise CandidateBlocked("SOURCE_SEMANTIC_STATUS_CONFLICT")
        pages.append({
            "index": idx, "physical": phy, "file": path, "sha": im["imageSha256"],
            "width": width, "height": height, "refs": refs,
        })
    return sorted(pages, key=lambda obj: obj["index"])


def distance(a: tuple[int, int], b: tuple[int, int]) -> float:
    return math.hypot(a[0]-b[0], a[1]-b[1])


def match_arrow_tip(triangle: list[tuple[int, int]],
                    segment: tuple[int, int, int, int],
                    max_gap: float = 16.0) -> dict | None:
    """Tentative *geometric* triangle+shaft match; no semantic relation implied.

    The longest triangle side is the base; a shaft must terminate by the base
    midpoint and align with base->apex. Ambiguity means return None.
    """
    if len(triangle) != 3 or max_gap <= 0:
        return None
    if len(set(triangle)) != 3:
        return None
    edges = [
        (distance(triangle[0], triangle[1]), 0, 1, 2),
        (distance(triangle[1], triangle[2]), 1, 2, 0),
        (distance(triangle[0], triangle[2]), 0, 2, 1),
    ]
    edges.sort(reverse=True)
    if edges[0][0] < 6 or edges[0][0] > 100:
        return None
    _, a, b, apex_index = edges[0]
    base = ((triangle[a][0]+triangle[b][0])/2,
            (triangle[a][1]+triangle[b][1])/2)
    tip = triangle[apex_index]
    head_vector = (tip[0]-base[0], tip[1]-base[1])
    head_norm = math.hypot(*head_vector)
    if head_norm < 3 or head_norm > edges[0][0]*2:
        return None
    x1,y1,x2,y2 = segment
    endpoints = [(x1,y1),(x2,y2)]
    near_idx = 0 if distance(endpoints[0],base) <= distance(endpoints[1],base) else 1
    near,far = endpoints[near_idx],endpoints[1-near_idx]
    if distance(near,base) > max_gap or distance(near,far) < 15:
        return None
    shaft_vec = (near[0]-far[0],near[1]-far[1])
    shaft_norm = math.hypot(*shaft_vec)
    cosine = (head_vector[0]*shaft_vec[0]+head_vector[1]*shaft_vec[1])/(head_norm*shaft_norm)
    if cosine < 0.90:
        return None
    return {"tip": [int(tip[0]),int(tip[1])],
            "baseMidpoint": [round(base[0],1),round(base[1],1)],
            "shaftEndpoint": [int(near[0]),int(near[1])],
            "shaftAngleCosine": round(cosine,4),
            "status": "GEOMETRIC_ARROWHEAD_CANDIDATE_UNVERIFIED"}


def normalize_hough_segment(value: object) -> tuple[int, int, int, int] | None:
    """Support HoughLinesP's (N,4) and (N,1,4) shapes across OpenCV builds."""
    if hasattr(value, "tolist"):
        value = value.tolist()
    for _ in range(3):
        if isinstance(value, (list, tuple)) and len(value) == 1:
            value = value[0]
        else:
            break
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in value):
        return None
    return tuple(int(v) for v in value)


def candidate_geometry(image, physical_page: int) -> tuple[dict, object]:
    """Compute bounded pixel-coordinate primitives using existing cv2."""
    import cv2
    height,width = image.shape[:2]
    gray = cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray,80,175)
    min_len = max(30,round(min(width,height)*0.045))
    raw = cv2.HoughLinesP(edges,1,math.pi/180,threshold=48,
                          minLineLength=min_len,maxLineGap=max(5,min_len//5))
    line_entries = []
    if raw is not None:
        for arr in raw:
            segment = normalize_hough_segment(arr)
            if segment is None:
                continue
            x1,y1,x2,y2 = segment
            length=math.hypot(x2-x1,y2-y1)
            if length >= min_len:
                line_entries.append((length,segment))
    line_entries.sort(key=lambda t:(-t[0],*t[1]))
    segments = [xy for _,xy in line_entries[:MAX_LINES]]
    lines = []
    for i,xy in enumerate(segments):
        x1,y1,x2,y2=xy
        angle=abs(math.degrees(math.atan2(y2-y1,x2-x1)))%180
        orient = ("HORIZONTAL_CANDIDATE" if min(angle,180-angle)<12
                  else "VERTICAL_CANDIDATE" if abs(angle-90)<12
                  else "DIAGONAL_CANDIDATE")
        lines.append({"id":f"line-{i+1:03d}","segmentPixels":[x1,y1,x2,y2],
                      "orientation":orient,"evidenceType":"IMAGE_GEOMETRY_ONLY"})
    blur=cv2.GaussianBlur(gray,(3,3),0)
    binary=cv2.adaptiveThreshold(blur,255,cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                cv2.THRESH_BINARY_INV,31,10)
    contours,_=cv2.findContours(binary,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
    if len(contours)>MAX_CONTOURS:
        raise CandidateBlocked("IMAGE_GEOMETRY_TOO_DENSE")
    boxes=[]
    triangles=[]
    for c in contours:
        peri=cv2.arcLength(c,True)
        if peri<25:continue
        poly=cv2.approxPolyDP(c,.028*peri,True)
        x,y,w,h=cv2.boundingRect(poly)
        if len(poly)==4 and cv2.isContourConvex(poly):
            if (w>=max(32,width*.07) and h>=max(23,height*.03)
                    and .00035<=w*h/(width*height)<=.30 and .15<=w/h<=10):
                boxes.append((w*h,(int(x),int(y),int(w),int(h))))
        if len(poly)==3 and cv2.isContourConvex(poly):
            if 7<=w<=max(90,round(width*.06)) and 7<=h<=max(90,round(height*.06)):
                pts=[(int(v[0][0]),int(v[0][1])) for v in poly]
                triangles.append(pts)
    boxes.sort(key=lambda t:(-t[0],*t[1]))
    # Keep bounded candidates, do not assert every large box is a node.
    boxes_out=[{"id":f"box-{i+1:03d}","bboxPixels":[*xy],
                "status":"RECTANGULAR_REGION_CANDIDATE_UNVERIFIED"}
               for i,(_,xy) in enumerate(boxes[:MAX_BOXES])]
    arrow_candidates=[]
    seen_tips=set()
    for tri in triangles:
        best=None
        for i,seg in enumerate(segments):
            match=match_arrow_tip(tri,seg,max_gap=max(10,min(width,height)*.014))
            if match and (best is None or match["shaftAngleCosine"]>best[0]):
                best=(match["shaftAngleCosine"],i,match)
        if best:
            _,shaft_index,m=best
            key=tuple(m["tip"])
            if key in seen_tips:continue
            seen_tips.add(key)
            m["shaftLineId"]=f"line-{shaft_index+1:03d}"
            arrow_candidates.append(m)
    arrow_candidates.sort(key=lambda p:(p["tip"][1],p["tip"][0]))
    arrow_truncated=len(arrow_candidates)>MAX_TIPS
    arrow_candidates=arrow_candidates[:MAX_TIPS]
    for i,item in enumerate(arrow_candidates):
        item["id"]=f"arrowtip-{i+1:03d}"
    overlay=image.copy()
    for b in boxes_out:
        x,y,w,h=b["bboxPixels"]
        cv2.rectangle(overlay,(x,y),(x+w,y+h),(20,170,40),2)
    for ln in lines:
        x1,y1,x2,y2=ln["segmentPixels"]
        cv2.line(overlay,(x1,y1),(x2,y2),(220,130,50),2)
    for arrow in arrow_candidates:
        t=arrow["tip"]
        cv2.circle(overlay,(t[0],t[1]),8,(40,40,220),2)
    result={
        "sourcePhysicalPage1Based":physical_page,
        "imageWidthPixels":width,"imageHeightPixels":height,
        "boxes":boxes_out,"lineSegments":lines,"arrowheadCandidates":arrow_candidates,
        "candidateCountTruncated":{"lines":len(line_entries)>MAX_LINES,
                                   "boxes":len(boxes)>MAX_BOXES,
                                   "arrowheads":arrow_truncated},
        "graphNodes":None,"graphEdges":None,"arrowDirectionRelations":None,
        "timingRelations":None,"semanticStatus":"UNVERIFIED_GEOMETRY_CANDIDATES_ONLY",
    }
    return result,overlay


def capture(root: Path, fixture: str) -> dict:
    import cv2
    inputs=validate_evidence(root,fixture)
    report=root/"reports"/SOURCE_RUN
    dest=report/("geometry-candidates-v1-"+fixture)
    stage=report/(".geometry-candidates-stage-v1-"+fixture)
    if dest.exists() or stage.exists() or dest.is_symlink() or stage.is_symlink():
        raise CandidateBlocked("OUTPUT_ALREADY_EXISTS")
    stage.mkdir()
    overall=[]
    try:
        (stage/"overlays").mkdir()
        for item in inputs:
            image=cv2.imread(str(item["file"]),cv2.IMREAD_COLOR)
            if image is None or image.shape[1]!=item["width"] or image.shape[0]!=item["height"]:
                raise CandidateBlocked("IMAGE_DECODING_OR_DIMENSION_MISMATCH")
            geometry,overlay=candidate_geometry(image,item["physical"])
            fname=f"page-{item['index']+1:03d}-candidate-overlay.png"
            out=stage/"overlays"/fname
            if not cv2.imwrite(str(out),overlay):
                raise CandidateBlocked("OVERLAY_WRITE_FAILED")
            if not regular(out,MAX_PNG_BYTES):
                raise CandidateBlocked("OVERLAY_TOO_LARGE")
            geometry["sourceRasterSha256"]=item["sha"]
            geometry["sourceFigureBlockRefs"]=item["refs"]
            geometry["overlayRelativePath"]="overlays/"+fname
            geometry["overlaySha256"]=sha_file(out)
            geometry["overlayBytes"]=out.stat().st_size
            overall.append(geometry)
            del overlay,image
        payload={
            "schemaVersion":"acs-pdf-figure-geometry-candidates-v1",
            "sourceRun":SOURCE_RUN,"fixtureId":fixture,
            "sourceEvidenceStatus":"SHA_VERIFIED",
            "pixelsFrom":"PRIVATE_SHA_VERIFIED_FULL_PAGE_PNG",
            "pages":overall,
            "noGraphSemanticsClaim":True,
            "candidateOnly":True,
        }
        with (stage/"geometry-candidates.json").open("x",encoding="utf-8") as fd:
            json.dump(payload,fd,indent=2,ensure_ascii=False)
            fd.flush()
            os.fsync(fd.fileno())
        os.rename(stage,dest)
    except BaseException:
        if stage.is_dir() and not stage.is_symlink():
            shutil.rmtree(stage)
        raise
    return {
        "fixtureId":fixture,"pagesProcessed":len(overall),
        "lineCandidates":sum(len(p["lineSegments"]) for p in overall),
        "regionCandidates":sum(len(p["boxes"]) for p in overall),
        "arrowTipCandidates":sum(len(p["arrowheadCandidates"]) for p in overall),
        "boundingBoxesReferencedToOriginalPng":True,
        "graphRelationsVerified":False,
        "timingRelationsVerified":False,
        "privateImageDataUploaded":False,
        "status":"PRIVATE_PIXEL_GEOMETRY_CANDIDATES_SAVED",
    }


def main() -> None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--fixture",choices=list(ALLOWED),required=True)
    args=parser.parse_args()
    try:
        result=capture(DATA_ROOT,args.fixture)
    except CandidateBlocked as exc:
        code = str(exc)
        if not re.fullmatch(r"[A-Z0-9_]{3,80}", code):
            code = "INVALID_SAFE_REASON"
        print("ACS_FIGURE_GEOMETRY_BLOCKED_REASON=" + code)
        sys.exit(2)
    except Exception as exc:
        cls = type(exc).__name__
        if not re.fullmatch(r"[A-Za-z]{3,48}", cls):
            cls = "Unknown"
        tb = exc.__traceback__
        while tb is not None and tb.tb_next is not None:
            tb = tb.tb_next
        fn = tb.tb_frame.f_code.co_name if tb is not None else "unknown"
        fn = fn if re.fullmatch(r"[A-Za-z_]{3,64}", fn) else "unknown"
        loc = tb.tb_lineno if tb is not None else 0
        print("ACS_FIGURE_GEOMETRY_BLOCKED_RUNTIME_CLASS=" + cls)
        print("ACS_FIGURE_GEOMETRY_BLOCKED_LOCATION=" + fn + "_" + str(loc))
        sys.exit(2)
    print("ACS_FIGURE_GEOMETRY_CANDIDATES="+json.dumps(result,sort_keys=True))


if __name__=="__main__":
    main()
