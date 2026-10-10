/**
 * REAL-BOOK-GT-ANNOTATOR-01 — browser/Node shared, pure and offline.
 * This module has no network, filesystem, PDF or parser APIs.
 * Browser edits are drafts. No human attestation or score is synthesized.
 */
export const DRAFT_SCHEMA = "acs-private-gt-draft-v1";
export const FIXTURES = Object.freeze({
  "RB-PDF-11": Object.freeze({ source: "RB-PDF-01", originals: [22, 107, 192] }),
  "RB-PDF-12": Object.freeze({ source: "RB-PDF-02", originals: [73, 145, 261] }),
  "RB-PDF-13": Object.freeze({ source: "RB-PDF-03", originals: [51, 127, 379] }),
});
export const ROLES = Object.freeze([
  "heading", "paragraph", "list_item", "table", "figure", "caption",
  "footnote", "formula", "header", "footer", "page_number",
]);
export const ROLE_LABELS = Object.freeze({
  heading: "标题", paragraph: "正文", list_item: "列表项",
  table: "表格", figure: "图像/示意图", caption: "图注",
  footnote: "脚注", formula: "公式", header: "页眉",
  footer: "页脚", page_number: "页码",
});
const BODY_ROLES = new Set(["heading", "paragraph", "list_item", "table", "caption", "footnote", "formula"]);
const NOISE_ROLES = new Set(["header", "footer", "page_number"]);
const CONTENT_ROLES = new Set(["heading", "paragraph", "list_item", "table", "figure", "caption", "footnote", "formula"]);
const MAX_BLOCKS_PER_PAGE = 500;
const MAX_FIELD = 100000;
export const MAX_DRAFT_BYTES = 4 * 1024 * 1024;

export class AnnotationError extends Error {
  constructor(code) { super(code); this.name = "AnnotationError"; this.code = code; }
}
function fail(code) { throw new AnnotationError(code); }
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
function boundedString(v, limit = MAX_FIELD) {
  if (typeof v !== "string" || v.length > limit) fail("DRAFT_FIELD_INVALID");
  return v;
}
function lines(text) {
  return text.split(/\r?\n/u).map(x => x.trim()).filter(Boolean);
}
export function normalizeText(text) {
  return text.normalize("NFKC").replace(/\p{White_Space}+/gu, "");
}
export function makeEmptyBlock(role = "paragraph") {
  if (!ROLES.includes(role)) fail("BLOCK_ROLE_INVALID");
  return { role, text: "", column: null, ordered: false, display: false, tableTsv: "" };
}
export function createDraft(fixtureId) {
  const spec = FIXTURES[fixtureId];
  if (!spec) fail("FIXTURE_NOT_ALLOWLISTED");
  return {
    schema: DRAFT_SCHEMA, fixtureId,
    pageSize: { width: 0, height: 0 },
    markersText: "",
    pages: spec.originals.map((originalPhysicalPage, index) => ({
      index, originalPhysicalPage, ocrRequired: false,
      ocrPhrasesText: "", blocks: [],
    })),
  };
}

/** Rebuild only allowlisted keys; never retain prototype, arbitrary paths, URLs,
 * PDF contents or user-provided properties that could be used by the UI.
 */
export function parseDraft(raw) {
  if (!object(raw) || raw.schema !== DRAFT_SCHEMA || !FIXTURES[raw.fixtureId]) fail("DRAFT_SCHEMA_INVALID");
  const spec = FIXTURES[raw.fixtureId];
  if (!object(raw.pageSize)) fail("PAGE_SIZE_INVALID");
  const width = raw.pageSize.width, height = raw.pageSize.height;
  if (![width, height].every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 20000)) fail("PAGE_SIZE_INVALID");
  if (!Array.isArray(raw.pages) || raw.pages.length !== 3) fail("DRAFT_PAGE_COUNT_INVALID");
  const pages = raw.pages.map((p, i) => {
    if (!object(p) || p.index !== i || p.originalPhysicalPage !== spec.originals[i] ||
        typeof p.ocrRequired !== "boolean" || !Array.isArray(p.blocks) || p.blocks.length > MAX_BLOCKS_PER_PAGE) {
      fail("DRAFT_PAGE_LINEAGE_INVALID");
    }
    const blocks = p.blocks.map(block => {
      if (!object(block) || !ROLES.includes(block.role)) fail("BLOCK_ROLE_INVALID");
      const column = block.column;
      if (column !== null && (!Number.isInteger(column) || column < 0 || column > 10)) fail("BLOCK_COLUMN_INVALID");
      if (typeof block.ordered !== "boolean" || typeof block.display !== "boolean") fail("BLOCK_FIELDS_INVALID");
      return {
        role: block.role,
        text: boundedString(block.text),
        column, ordered: block.ordered, display: block.display,
        tableTsv: boundedString(block.tableTsv, 50000),
      };
    });
    return {
      index: i, originalPhysicalPage: spec.originals[i],
      ocrRequired: p.ocrRequired,
      ocrPhrasesText: boundedString(p.ocrPhrasesText, 20000), blocks,
    };
  });
  return {
    schema: DRAFT_SCHEMA, fixtureId: raw.fixtureId,
    pageSize: { width, height },
    markersText: boundedString(raw.markersText, 20000), pages,
  };
}
function tableGrid(tsv) {
  if (!tsv.trim()) fail("TABLE_CELLS_REQUIRED");
  // Do not trim the TSV payload: leading/trailing tabs represent actual
  // blank edge cells, as required by GtTable's empty-string cell semantics.
  const rows = tsv.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  if (rows.at(-1) === "") rows.pop(); // Ignore only a final newline.
  const grid = rows.map(row => row.split("\t"));
  if (grid.length > 50 || grid.some(r => r.length > 30 || r.some(cell => cell.length > 1000))) fail("TABLE_GRID_TOO_LARGE");
  const cols = grid[0]?.length;
  if (!cols || grid.some(row => row.length !== cols)) fail("TABLE_GRID_NOT_RECTANGULAR");
  return grid;
}

/** The browser helps transcribe GT; it does NOT independently confirm the source
 * nor create the 2-person .ground-truth.review.json certificate.
 */
export function buildGroundTruth(rawDraft) {
  const draft = parseDraft(rawDraft);
  const { width, height } = draft.pageSize;
  if (width <= 0 || height <= 0) fail("PAGE_SIZE_REQUIRED");
  const markers = lines(draft.markersText);
  if (markers.length === 0 || markers.length > 100) fail("KEY_MARKERS_REQUIRED");
  if (new Set(markers).size !== markers.length) fail("KEY_MARKERS_DUPLICATED");
  const gt = {
    fixtureId: draft.fixtureId,
    generator: "human-curated-from-original",
    pages: 3,
    pageSize: { width, height },
    ocrRequired: false, ocrRequiredPages: [],
    normalizationPolicy: "NFKC + remove whitespace",
    text: "", keyMarkers: markers, ocrKeyPhrases: [],
    blocks: [], headings: [], lists: [], tables: [], formulas: [], noise: [],
  };
  const canonical = [];
  const noiseSeen = new Set();
  for (const page of draft.pages) {
    if (!page.blocks.some(b => CONTENT_ROLES.has(b.role))) fail("GROUND_TRUTH_PAGE_CONTENT_MISSING");
    let currentList = null;
    for (const block of page.blocks) {
      // B1...Bn are assigned strictly in manual page/reading order.
      // Preserve table-cell text and formula transcription in the canonical
      // text, matching the repository's synthetic GT builder. A figure's
      // human image description is structural evidence, not invented prose.
      let bodyText = block.text;
      if (block.role === "table") {
        const grid = tableGrid(block.tableTsv);
        const recoveredCells = grid.map(row => row.join(" ")).join("\n");
        bodyText = [block.text.trim(), recoveredCells].filter(Boolean).join("\n");
        gt.tables.push({ page: page.index, rows: grid.length, cols: grid[0].length, cells: grid });
      }
      const id = "B" + (gt.blocks.length + 1);
      gt.blocks.push({ id, page: page.index, column: block.column, role: block.role, text: bodyText });
      if (BODY_ROLES.has(block.role) && bodyText.trim()) canonical.push(bodyText);
      if (block.role === "heading" && block.text.trim()) {
        gt.headings.push({ page: page.index, text: block.text });
      }
      if (block.role === "formula") {
        if (!block.text.trim()) fail("FORMULA_TEXT_REQUIRED");
        gt.formulas.push({ page: page.index, display: block.display, text: block.text });
      }
      if (block.role === "list_item") {
        if (!block.text.trim()) fail("LIST_ITEM_TEXT_REQUIRED");
        if (currentList && currentList.ordered === block.ordered) currentList.items.push(block.text);
        else {
          currentList = { page: page.index, ordered: block.ordered, items: [block.text] };
          gt.lists.push(currentList);
        }
      } else currentList = null;
      if (NOISE_ROLES.has(block.role) && block.text.trim()) {
        const key = block.role + "\0" + block.text;
        if (!noiseSeen.has(key)) {
          noiseSeen.add(key);
          gt.noise.push({ kind: block.role, text: block.text });
        }
      }
    }
    if (page.ocrRequired) gt.ocrRequiredPages.push(page.index);
    const phrases = lines(page.ocrPhrasesText);
    if (phrases.length > 50) fail("OCR_PHRASES_TOO_MANY");
    if (!page.ocrRequired && phrases.length) fail("OCR_PAGE_NOT_SELECTED");
    for (const phrase of phrases) gt.ocrKeyPhrases.push({ page: page.index, phrase });
  }
  gt.ocrRequired = gt.ocrRequiredPages.length > 0;
  gt.text = canonical.join("\n");
  const normalized = normalizeText(gt.text);
  if (!normalized) fail("CANONICAL_TEXT_REQUIRED");
  for (const marker of markers) if (!normalizeText(marker) || !normalized.includes(normalizeText(marker))) fail("GROUND_TRUTH_MARKER_CONFLICT");
  for (const phrase of gt.ocrKeyPhrases) {
    if (!normalizeText(phrase.phrase) || !normalized.includes(normalizeText(phrase.phrase))) fail("OCR_PHRASE_NOT_IN_CANONICAL_TEXT");
  }
  if (new TextEncoder().encode(JSON.stringify(gt)).length > MAX_DRAFT_BYTES) fail("GT_TOO_LARGE");
  return gt;
}

/** Status never labels the result reviewed, accepted, scored or completed. */
export function assessDraft(raw) {
  try {
    const gt = buildGroundTruth(raw);
    return {
      status: "READY_FOR_INDEPENDENT_REVIEW",
      blocks: gt.blocks.length,
      pages: gt.pages,
      ocrPages: gt.ocrRequiredPages.length,
      message: "格式候选已通过本地检查，但尚未经原书人工复核，不能执行质量评分。",
    };
  } catch (error) {
    if (!(error instanceof AnnotationError)) throw error;
    return { status: "DRAFT_INCOMPLETE", code: error.code, message: "草稿尚不满足导出条件：" + error.code };
  }
}
