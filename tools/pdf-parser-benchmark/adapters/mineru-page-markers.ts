/**
 * MinerU Markdown page-marker parser (01H).
 *
 * MinerU 4.x emits page provenance in its markdown output:
 *   <!-- page N of M -->
 * and per-image traceability references:
 *   ![Image block](doc:<id>/tier:<tier>/page:N/block:M)
 *
 * This module is the ONLY place that turns those markers into page-bound
 * content groups. It parses data only — it never opens paths, never executes
 * `doc:` targets, and never infers a page number from content or similarity.
 *
 * Invariants (01H spec):
 *  1. Raw markdown content is never dropped: every non-marker line ends up in
 *     exactly one content block; markers themselves are not content.
 *  2. A deterministic pageIndex exists ONLY from validated page markers.
 *  3. Upstream markers are 1-based; DTO pageIndex is 0-based.
 *  4. Page numbers must be consecutive, unique, ordered 1..M.
 *  5. Every block belongs to the page segment it physically appeared in.
 *  6. `doc:page:N` refs must match their enclosing segment page.
 *  7. Local (processed-document) page indexes are distinct from original-book
 *     physical pages; book mapping happens via pinned manifest lineage in the
 *     product layer, never here.
 *  8. No semantic/similarity inference fills in missing page numbers.
 *  9. Unprovable page binding stays unknown (status MISSING → pageIndex null).
 * 10. Any inconsistency yields INVALID → callers must fail closed; a run with
 *     invalid markers can never produce a successful normalized result.
 * 11. Grouping preserves the original reading order.
 * 12. Markers inside fenced code blocks are content, never metadata.
 */

export type MineruImageRef = {
  doc: string;
  tier: string;
  /** 1-based page as written in the ref. */
  page: number;
  block: number;
  /** The raw markdown line, preserved verbatim for auditability. */
  raw: string;
};

export type MineruContentBlock = {
  kind: "paragraph" | "heading" | "figure" | "code";
  text: string;
  imageRef: MineruImageRef | null;
};

export type MineruPageGroup = {
  /** 1-based, as written in the upstream marker. */
  pageLocal1Based: number;
  blocks: MineruContentBlock[];
  imageRefs: MineruImageRef[];
};

export type MineruMarkerFailure = {
  code: string;
  detail: string;
};

export type MineruPageMarkersValid = {
  status: "VALID";
  declaredTotalPages: number;
  pages: MineruPageGroup[];
};

export type MineruPageMarkersMissing = {
  status: "MISSING";
};

export type MineruPageMarkersInvalid = {
  status: "INVALID";
  failure: MineruMarkerFailure;
};

export type MineruPageMarkersResult = MineruPageMarkersValid | MineruPageMarkersMissing | MineruPageMarkersInvalid;

export type ParseMineruPageMarkersContext = {
  /**
   * Total pages the processed document is expected to have (e.g. fixture
   * declaredPages when the whole document was processed). When provided and
   * the marker total disagrees → INVALID (fail-closed).
   */
  expectedTotalPages?: number;
  /**
   * Full sha256 of the processed fixture. When provided, every `doc:` id must
   * be a non-empty prefix of it (MinerU writes a short prefix) — otherwise
   * DOC_ID_MISMATCH (source-identity fail-closed).
   */
  verifyDocIdPrefix?: string;
};

const MARKER_RE = /^<!--\s*page\s+(\d+)\s+of\s+(\d+)\s*-->\s*$/;
const MALFORMED_MARKER_LIKE_RE = /^\s*<!--\s*page\b/i;
const IMAGE_REF_RE = /^!\[Image block\]\(doc:([^)\s]+)\/tier:([A-Za-z0-9._-]+)\/page:(\d+)\/block:(\d+)\)\s*$/;
const IMAGE_LINE_RE = /^!\[/;
const FENCE_RE = /^\s*```/;

type LineKind = "marker" | "malformed-marker" | "fence" | "image" | "content" | "blank";

function classifyLines(markdown: string): Array<{ kind: LineKind; text: string; marker?: { page: number; total: number } }> {
  // Normalize CRLF/CR to LF only; never alter line content itself.
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: Array<{ kind: LineKind; text: string; marker?: { page: number; total: number } }> = [];
  let inFence = false;
  for (const line of lines) {
    if (!inFence && FENCE_RE.test(line)) {
      out.push({ kind: "fence", text: line });
      inFence = true;
      continue;
    }
    if (inFence && FENCE_RE.test(line)) {
      out.push({ kind: "fence", text: line });
      inFence = false;
      continue;
    }
    if (inFence) {
      out.push({ kind: "content", text: line });
      continue;
    }
    const marker = line.match(MARKER_RE);
    if (marker) {
      out.push({ kind: "marker", text: line, marker: { page: Number(marker[1]), total: Number(marker[2]) } });
      continue;
    }
    if (MALFORMED_MARKER_LIKE_RE.test(line)) {
      out.push({ kind: "malformed-marker", text: line });
      continue;
    }
    if (line.trim() === "") {
      out.push({ kind: "blank", text: line });
      continue;
    }
    if (IMAGE_LINE_RE.test(line)) {
      out.push({ kind: "image", text: line });
      continue;
    }
    out.push({ kind: "content", text: line });
  }
  return out;
}

function parseImageRef(raw: string): MineruImageRef | { syntaxError: string } {
  const m = raw.match(IMAGE_REF_RE);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined || m[4] === undefined) {
    return { syntaxError: raw.slice(0, 120) };
  }
  const page = Number(m[3]);
  const block = Number(m[4]);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(block) || block < 1) {
    return { syntaxError: raw.slice(0, 120) };
  }
  return { doc: m[1], tier: m[2], page, block, raw };
}

function groupSegmentIntoBlocks(lines: Array<{ kind: LineKind; text: string }>): MineruContentBlock[] {
  const blocks: MineruContentBlock[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    if (current.length === 0) return;
    const text = current.join("\n");
    blocks.push({ kind: text.startsWith("#") ? "heading" : text.startsWith("```") ? "code" : "paragraph", text, imageRef: null });
    current = [];
  };
  for (const line of lines) {
    if (line.kind === "fence") {
      if (!inFence) {
        // Opening fence starts a fresh code block.
        flush();
        current.push(line.text);
        inFence = true;
      } else {
        // Closing fence belongs to the current code block.
        current.push(line.text);
        inFence = false;
        flush();
      }
      continue;
    }
    if (inFence) {
      current.push(line.text);
      continue;
    }
    if (line.kind === "image") {
      flush();
      blocks.push({ kind: "figure", text: line.text, imageRef: null });
      continue;
    }
    if (line.kind === "blank") {
      flush();
      continue;
    }
    current.push(line.text);
  }
  flush();
  return blocks;
}

/**
 * Parse MinerU markdown into page-marker-proven content groups.
 * Pure function: no filesystem access, no execution of `doc:` targets.
 */
export function parseMineruPageMarkers(markdown: string, context: ParseMineruPageMarkersContext = {}): MineruPageMarkersResult {
  const lines = classifyLines(markdown);
  // A present but malformed marker cannot degrade to MISSING provenance.
  if (lines.some((line) => line.kind === "malformed-marker")) {
    return { status: "INVALID", failure: { code: "PAGE_MARKER_SYNTAX_INVALID", detail: "malformed MinerU page marker" } };
  }

  const markers: Array<{ index: number; page: number; total: number }> = lines.flatMap((l, index) =>
    l.kind === "marker" && l.marker ? [{ index, page: l.marker.page, total: l.marker.total }] : [],
  );
  if (markers.length === 0) return { status: "MISSING" };

  // Total-page consistency across markers.
  const totals = new Set(markers.map((m) => m.total));
  if (totals.size !== 1) {
    return { status: "INVALID", failure: { code: "PAGE_MARKER_TOTAL_CONFLICT", detail: `markers declare conflicting totals: ${[...totals].join(",")}` } };
  }
  const declaredTotalPages: number = markers[0] !== undefined ? markers[0].total : 0;

  // Consecutive, unique, ordered 1..M (covers duplicates, gaps, out-of-order, zero).
  const expectedSequence = markers.map((_, i) => i + 1);
  const actualSequence = markers.map((m) => m.page);
  if (actualSequence.some((n) => !Number.isSafeInteger(n) || n < 1)) {
    return { status: "INVALID", failure: { code: "PAGE_MARKER_NUMBER_INVALID", detail: `non-positive page number: ${actualSequence.join(",")}` } };
  }
  if (actualSequence.some((n, i) => n !== expectedSequence[i])) {
    return { status: "INVALID", failure: { code: "PAGE_MARKER_ORDER_INVALID", detail: `expected ${expectedSequence.join(",")} got ${actualSequence.join(",")}` } };
  }
  // Truncation guard: every declared page must actually have a segment.
  if (actualSequence.length !== declaredTotalPages) {
    return { status: "INVALID", failure: { code: "PAGE_SEGMENT_COUNT_MISMATCH", detail: `markers declare total ${declaredTotalPages} but only ${actualSequence.length} page segments exist` } };
  }

  // No real content before the first marker (blank lines are tolerated).
  const firstMarker = markers[0];
  if (firstMarker === undefined) return { status: "MISSING" };
  const beforeFirst = lines.slice(0, firstMarker.index);
  if (beforeFirst.some((l) => l.kind === "content" || l.kind === "image" || l.kind === "fence")) {
    return { status: "INVALID", failure: { code: "CONTENT_BEFORE_FIRST_MARKER", detail: "non-blank markdown precedes the first page marker" } };
  }

  // Declared total vs expected processed page count.
  if (context.expectedTotalPages !== undefined && declaredTotalPages !== context.expectedTotalPages) {
    return { status: "INVALID", failure: { code: "PAGE_TOTAL_MISMATCH", detail: `markers declare ${declaredTotalPages} pages, processed document has ${context.expectedTotalPages}` } };
  }

  // Segment boundaries: marker line index ranges.
  const segments: Array<{ pageLocal1Based: number; lines: Array<{ kind: LineKind; text: string }> }> = [];
  for (let k = 0; k < markers.length; k++) {
    const marker = markers[k]!;
    const next = markers[k + 1];
    const start = marker.index + 1;
    const end = next !== undefined ? next.index : lines.length;
    segments.push({ pageLocal1Based: marker.page, lines: lines.slice(start, end) });
  }

  // Image-ref validation and grouping.
  const pages: MineruPageGroup[] = [];
  let seenDocId: string | null = null;
  for (const segment of segments) {
    const imageRefs: MineruImageRef[] = [];
    for (const line of segment.lines) {
      if (line.kind !== "image") continue;
      const ref = parseImageRef(line.text);
      if ("syntaxError" in ref) {
        return { status: "INVALID", failure: { code: "IMAGE_REF_SYNTAX_INVALID", detail: `unparsable doc image reference: ${ref.syntaxError}` } };
      }
      if (ref.page !== segment.pageLocal1Based) {
        return { status: "INVALID", failure: { code: "IMAGE_REF_PAGE_CONFLICT", detail: `doc ref page ${ref.page} inside marker page ${segment.pageLocal1Based}` } };
      }
      if (context.verifyDocIdPrefix !== undefined) {
        const prefix = context.verifyDocIdPrefix;
        if (!(ref.doc.length >= 6 && prefix.startsWith(ref.doc))) {
          return { status: "INVALID", failure: { code: "DOC_ID_MISMATCH", detail: `doc id ${ref.doc} is not a prefix of fixture sha256` } };
        }
      }
      if (seenDocId === null) seenDocId = ref.doc;
      else if (seenDocId !== ref.doc) {
        return { status: "INVALID", failure: { code: "DOC_ID_MISMATCH", detail: `conflicting doc ids ${seenDocId} vs ${ref.doc}` } };
      }
      imageRefs.push(ref);
    }
    const rawBlocks = groupSegmentIntoBlocks(segment.lines);
    // Attach parsed refs to their figure blocks (same raw line).
    const blocks = rawBlocks.map((b) => {
      if (b.kind !== "figure") return b;
      const ref = imageRefs.find((r) => r.raw === b.text) ?? null;
      return { ...b, imageRef: ref };
    });
    pages.push({ pageLocal1Based: segment.pageLocal1Based, blocks, imageRefs });
  }

  return { status: "VALID", declaredTotalPages, pages };
}

/**
 * DTO-safe lossless text splitting. zod caps NormalizedBlock.text at
 * 200_000 chars; oversize blocks are split at line boundaries (fallback:
 * hard slice) so that concatenation is byte-identical to the input —
 * never silently truncated.
 */
export const NORMALIZED_BLOCK_TEXT_LIMIT = 200_000;

export function splitOversizeText(text: string, limit: number = NORMALIZED_BLOCK_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit; // no usable line boundary in range — hard slice, still lossless
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}
