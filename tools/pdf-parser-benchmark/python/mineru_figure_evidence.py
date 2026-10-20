"""Capture durable PAGE-LEVEL visual evidence for validated MinerU figure refs.

No claim is made that a page PNG is a cropped figure, a recognized graph,
a recovered arrow, or a semantic interpretation of the image.

Run on the owner's Windows host only. Dependencies must ALREADY be installed.
All source PDFs, Markdown, images and manifests remain in the private D: root.
Nothing from this script is ever uploaded to GitHub Actions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

DATA_ROOT = Path(r"D:\ai-cognitive-pdf-benchmark-data")
INPUTS = {
    "RB-PDF-12": ("RB-PDF-02", (73, 145, 261)),
    "RB-PDF-13": ("RB-PDF-03", (51, 127, 379)),
}
MARKER = re.compile(r"^<!--\s*page\s+(\d+)\s+of\s+(\d+)\s*-->$")
MARKER_LIKE = re.compile(r"^\s*<!--\s*page\b", re.I)
IMAGE = re.compile(
    r"^!\[Image block\]\(doc:([0-9a-f]+)/tier:([a-z0-9._-]+)/page:(\d+)/block:(\d+)\)$"
)
RUN_LABEL = re.compile(r"^real-mineru-[0-9]{8,12}-[1-9][0-9]{0,2}$")
FENCE = re.compile(r"^\s*"+chr(96)*3)


class EvidenceBlocked(ValueError):
    """Safe failure: do not leak a source path or document content in logs."""


@dataclass(frozen=True)
class FigurePage:
    local_page: int
    refs: tuple[str, ...]


def sha256_bytes(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def sha256_path(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for part in iter(lambda: f.read(1 << 20), b""):
            h.update(part)
    return h.hexdigest()


def is_link(path: Path) -> bool:
    try:
        return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())
    except OSError:
        return True


def regular_file(path: Path, maximum: int) -> bool:
    try:
        return (not is_link(path) and path.is_file()
                and 0 < path.stat().st_size <= maximum)
    except OSError:
        return False


def require_dir(path: Path) -> None:
    if is_link(path) or not path.is_dir():
        raise EvidenceBlocked("UNSAFE_PRIVATE_DIRECTORY")


def validate_source(data_root: Path, fixture_id: str) -> tuple[Path, str, tuple[int, ...]]:
    """Validate subset AND parent bytes against the existing private manifest."""
    if fixture_id not in INPUTS:
        raise EvidenceBlocked("UNKNOWN_FIXTURE")
    require_dir(data_root)
    fixture_dir = data_root / "fixtures"
    require_dir(fixture_dir)
    mf = fixture_dir / "fixtures.manifest.json"
    if not regular_file(mf, 1_048_576):
        raise EvidenceBlocked("MANIFEST_NOT_READY")
    try:
        rows = json.loads(mf.read_text(encoding="utf-8"))["fixtures"]
        if not isinstance(rows, list) or len(rows) > 10_000:
            raise ValueError()
    except (ValueError, KeyError, TypeError, UnicodeError):
        raise EvidenceBlocked("MANIFEST_INVALID") from None

    def row(fid: str) -> dict:
        matched = [v for v in rows if isinstance(v, dict) and v.get("id") == fid]
        if len(matched) != 1:
            raise EvidenceBlocked("MANIFEST_DUPLICATE_OR_MISSING")
        return matched[0]

    parent_id, original_pages = INPUTS[fixture_id]
    sub, parent = row(fixture_id), row(parent_id)
    if (sub.get("fixtureClass") != "private-real-page-subset"
            or sub.get("filename") != fixture_id + ".pdf"
            or sub.get("sourceFixtureId") != parent_id
            or sub.get("sourcePages1Based") != list(original_pages)
            or sub.get("sourceSha256") != parent.get("expectedSha256")):
        raise EvidenceBlocked("FIXTURE_LINEAGE_MISMATCH")

    def pinned_pdf(record: dict, fid: str) -> Path:
        digest = record.get("expectedSha256")
        expected_size = record.get("declaredBytes")
        if (not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)
                or type(expected_size) is not int or expected_size <= 0):
            raise EvidenceBlocked("UNPINNED_INPUT")
        source = fixture_dir / (fid + ".pdf")
        if not regular_file(source, 200_000_000) or source.stat().st_size != expected_size:
            raise EvidenceBlocked("INPUT_SIZE_OR_TYPE_MISMATCH")
        if sha256_path(source) != digest:
            raise EvidenceBlocked("INPUT_SHA_MISMATCH")
        return source

    source = pinned_pdf(sub, fixture_id)
    pinned_pdf(parent, parent_id)
    return source, sub["expectedSha256"], original_pages


def plan_figures(markdown: str, expected_sha: str, expected_pages: int = 3,
                 expected_tier: str = "flash") -> list[FigurePage]:
    """Parse only explicitly documented 1-based page markers and image refs.

    This code does not infer figure bounds from reading order or resolve doc:
    references as URLs, file paths, or executable addresses.
    """
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha):
        raise EvidenceBlocked("INPUT_DIGEST_INVALID")
    if not 1 <= expected_pages <= 50 or expected_tier not in ("flash", "basic"):
        raise EvidenceBlocked("EXPECTED_PAGE_SCOPE_INVALID")
    markers: list[tuple[int, int]] = []
    ref_by_page: dict[int, list[str]] = {i: [] for i in range(1, expected_pages + 1)}
    seen_refs: set[str] = set()
    in_fence = False
    current: int | None = None
    for line in markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if FENCE.match(line):
            if current is None:
                raise EvidenceBlocked("CONTENT_BEFORE_PAGE_MARKER")
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        match = MARKER.fullmatch(line)
        if match:
            page, total = map(int, match.groups())
            markers.append((page, total))
            current = page
            continue
        if MARKER_LIKE.match(line):
            raise EvidenceBlocked("MALFORMED_PAGE_MARKER")
        if current is None:
            if line.strip():
                raise EvidenceBlocked("CONTENT_BEFORE_PAGE_MARKER")
            continue
        if line.startswith("!["):
            img = IMAGE.fullmatch(line)
            if img is None:
                raise EvidenceBlocked("UNTRUSTED_FIGURE_REF")
            doc_id, tier, page_raw, block_raw = img.groups()
            ref_page, block = int(page_raw), int(block_raw)
            if (len(doc_id) < 6 or not expected_sha.startswith(doc_id)
                    or tier != expected_tier or ref_page != current
                    or block < 1 or block > 100_000 or line in seen_refs):
                raise EvidenceBlocked("FIGURE_REF_IDENTITY_OR_PAGE_INVALID")
            seen_refs.add(line)
            ref_by_page[current].append(
                f"doc:{doc_id}/tier:{tier}/page:{ref_page}/block:{block}"
            )
            if len(ref_by_page[current]) > 100 or len(seen_refs) > 300:
                raise EvidenceBlocked("TOO_MANY_FIGURE_REFS")
    if in_fence:
        raise EvidenceBlocked("UNCLOSED_CODE_FENCE")
    if markers != [(i, expected_pages) for i in range(1, expected_pages + 1)]:
        raise EvidenceBlocked("PAGE_MARKER_SEQUENCE_INVALID")
    return [FigurePage(page, tuple(ref_by_page[page]))
            for page in range(1, expected_pages + 1) if ref_by_page[page]]


def capture(data_root: Path, fixture_id: str, source_run: str) -> dict:
    """Persist rasterized complete pages only for pages with verified refs.

    Original figure bounding boxes are unknown. Each ref links to its
    full-page raster fallback with regionType=FULL_PAGE_UNCROPPED.
    """
    if not RUN_LABEL.fullmatch(source_run):
        raise EvidenceBlocked("RUN_ID_NOT_ALLOWLISTED")
    pdf, digest, physical_pages = validate_source(data_root, fixture_id)
    report_root = data_root / "reports"
    require_dir(report_root)
    report = report_root / source_run
    require_dir(report)
    md_file = report / (fixture_id + ".md")
    if not regular_file(md_file, 12_000_000):
        raise EvidenceBlocked("PRIVATE_MARKDOWN_NOT_READY")
    markdown = md_file.read_text(encoding="utf-8-sig")
    planned = plan_figures(markdown, digest)
    if not planned:
        raise EvidenceBlocked("NO_FIGURE_REFERENCES")

    import pypdfium2 as pdfium  # verified installed on Windows host; no download
    target = report / ("figure-evidence-v1-" + fixture_id)
    stage = report / (".figure-evidence-stage-v1-" + fixture_id)
    if target.exists() or is_link(target) or stage.exists() or is_link(stage):
        raise EvidenceBlocked("EVIDENCE_DESTINATION_COLLISION")
    count = 0
    total_bytes = 0
    manifest_images = []
    stage.mkdir()
    try:
        images = stage / "pages"
        images.mkdir()
        doc = pdfium.PdfDocument(str(pdf))
        try:
            if len(doc) != len(physical_pages):
                raise EvidenceBlocked("PDF_PAGE_COUNT_MISMATCH")
            for item in planned:
                page = doc[item.local_page - 1]
                bitmap = page.render(scale=1.5)
                pil = bitmap.to_pil()
                if pil.width < 1 or pil.height < 1 or pil.width * pil.height > 32_000_000:
                    raise EvidenceBlocked("RENDER_DIMENSIONS_INVALID")
                name = f"page-{item.local_page:03d}.png"
                image = images / name
                pil.save(image, format="PNG")
                size = image.stat().st_size
                if size < 100 or size > 20_000_000:
                    raise EvidenceBlocked("RENDER_SIZE_INVALID")
                count += 1
                total_bytes += size
                if total_bytes > 90_000_000:
                    raise EvidenceBlocked("RENDER_OUTPUT_BUDGET_EXCEEDED")
                manifest_images.append({
                    "subsetPageIndex": item.local_page - 1,
                    "sourcePhysicalPage1Based": physical_pages[item.local_page - 1],
                    "relativeImagePath": "pages/" + name,
                    "imageSha256": sha256_path(image),
                    "imageBytes": size,
                    "widthPixels": pil.width,
                    "heightPixels": pil.height,
                    "regionType": "FULL_PAGE_UNCROPPED",
                    "sourceFigureBlockRefs": list(item.refs),
                    "figureRegionBounds": None,
                    "diagramNodes": None,
                    "diagramEdges": None,
                    "graphSemantics": "NOT_VERIFIED",
                })
                pil.close()
                page.close()
        finally:
            doc.close()
        document = {
            "schemaVersion": "acs-mineru-figure-page-evidence-v1",
            "fixtureId": fixture_id,
            "sourceRun": source_run,
            "sourceSubsetSha256": digest,
            "sourceMarkdownSha256": sha256_path(md_file),
            "sourcePages1Based": list(physical_pages),
            "images": manifest_images,
            "claim": "PERSISTED_FULL_PAGE_VISUAL_FALLBACK_ONLY",
            "noCroppedFigureOrDiagramRelationshipClaim": True,
        }
        manifest_path = stage / "figure-evidence.json"
        with manifest_path.open("x", encoding="utf-8") as f:
            json.dump(document, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.rename(stage, target)  # never replace a preexisting destination
    except BaseException:
        if stage.is_dir() and not is_link(stage):
            shutil.rmtree(stage)
        raise
    return {
        "status": "PAGE_VISUAL_FALLBACK_PERSISTED",
        "fixtureId": fixture_id,
        "sourcePhysicalPages": list(physical_pages),
        "rasterPages": count,
        "figureRefsMapped": sum(len(i.refs) for i in planned),
        "totalPngBytes": total_bytes,
        "sourceChecksumVerified": True,
        "imageEvidenceManifestSaved": True,
        "croppedFigureRegionsVerified": False,
        "diagramGraphVerified": False,
        "privateContentUploaded": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", choices=tuple(INPUTS), required=True)
    parser.add_argument("--source-run", required=True)
    args = parser.parse_args()
    try:
        output = capture(DATA_ROOT, args.fixture, args.source_run)
    except Exception:
        # Never send the private filename, OCR text or a library exception to CI.
        print("ACS_MINERU_FIGURE_CAPTURE_BLOCKED")
        sys.exit(2)
    print("ACS_MINERU_FIGURE_CAPTURE=" + json.dumps(output, sort_keys=True))


if __name__ == "__main__":
    main()
