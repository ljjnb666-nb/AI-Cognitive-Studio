/**
 * REAL-BOOK-GT-ANNOTATOR-02 — pure offline, browser/Node compatible.
 * Candidate parser output NEVER becomes human GT and NEVER establishes accuracy.
 * User-selected files are parsed only inside the browser; server has no private-data API.
 */
import { AnnotationError, FIXTURES, buildGroundTruth, normalizeText, parseDraft } from "./workspace.mjs";

const fail = code => { throw new AnnotationError(code); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = value => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const MAX_NAME = 500;
export const MAX_CANDIDATE_BYTES = 24 * 1024 * 1024;
export const MAX_SELECTION_BYTES = 1024 * 1024;
export const MAX_PDF_BYTES = 170 * 1024 * 1024;
export const MAX_COMPARE_BLOCKS = 500;

function archiveName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NAME ||
      value.includes("\\") || value.includes("\0") ||
      value.split("/").some(part => !part || part === "." || part === "..") ||
      !value.toLowerCase().endsWith(".pdf")) fail("BOOK_MAPPING_MEMBER_INVALID");
  const file = value.split("/").at(-1);
  if (!file || file.length > 240) fail("BOOK_MAPPING_MEMBER_INVALID");
  return file;
}

/** Only retain the names and expected identities for three known, local samples. */
export function parseBookSelection(raw) {
  if (!plain(raw) || raw.schema_version !== "acs-real-book-fixtures-v1" ||
      !Array.isArray(raw.selection) || raw.selection.length > 200) fail("BOOK_MAPPING_SCHEMA_INVALID");
  const found = Object.create(null);
  for (const row of raw.selection) {
    if (!plain(row) || typeof row.id !== "string") fail("BOOK_MAPPING_SCHEMA_INVALID");
    if (!["RB-PDF-01", "RB-PDF-02", "RB-PDF-03"].includes(row.id)) continue;
    if (Object.hasOwn(found, row.id) || row.format !== "pdf" || !sha(row.sha256) ||
        !Number.isInteger(row.pages) || row.pages < 1 || row.pages > 5000 ||
        !Number.isInteger(row.bytes) || row.bytes < 1 || row.bytes > MAX_PDF_BYTES) fail("BOOK_MAPPING_SOURCE_INVALID");
    found[row.id] = Object.freeze({
      sourceId: row.id, displayName: archiveName(row.archive_member),
      sha256: row.sha256, pages: row.pages, bytes: row.bytes,
    });
  }
  if (Object.keys(found).length !== 3) fail("BOOK_MAPPING_INCOMPLETE");
  for (const spec of Object.values(FIXTURES)) {
    if (Math.max(...spec.originals) > found[spec.source].pages) fail("BOOK_MAPPING_PAGE_OUT_OF_RANGE");
  }
  return Object.freeze(found);
}

export function bookLabel(mapping, fixtureId) {
  if (!FIXTURES[fixtureId]) fail("FIXTURE_NOT_ALLOWLISTED");
  const source = FIXTURES[fixtureId].source;
  return mapping?.[source]?.displayName ?? source + "（未导入本机书名映射）";
}

/** A normalized.json is a machine candidate, not a source-attested GT artifact. */
export function parseNormalizedCandidate(raw, expectedFixtureId) {
  if (!FIXTURES[expectedFixtureId]) fail("FIXTURE_NOT_ALLOWLISTED");
  if (!plain(raw) || raw.fixtureId !== expectedFixtureId ||
      !plain(raw.parser) || typeof raw.parser.name !== "string" ||
      raw.parser.name.length < 1 || raw.parser.name.length > 70 ||
      typeof raw.parser.version !== "string" || raw.parser.version.length < 1 ||
      raw.parser.version.length > 100 ||
      !Array.isArray(raw.pages) || raw.pages.length !== 3 ||
      typeof raw.readingOrderAvailable !== "boolean") fail("CANDIDATE_SCHEMA_OR_FIXTURE_MISMATCH");
  const seen = new Set();
  let unknownBindings = 0;
  let size = 0;
  const pages = raw.pages.map((page) => {
    if (!plain(page) || !Number.isInteger(page.pageIndex) ||
        page.pageIndex < 0 || page.pageIndex > 2 || seen.has(page.pageIndex) ||
        !Array.isArray(page.blocks) || page.blocks.length > MAX_COMPARE_BLOCKS) fail("CANDIDATE_PAGE_LAYOUT_INVALID");
    seen.add(page.pageIndex);
    const blocks = page.blocks.map((block, i) => {
      if (!plain(block) || typeof block.kind !== "string" || block.kind.length > 100 ||
          typeof block.text !== "string" || block.text.length > 200_000 ||
          (block.pageIndex !== null && block.pageIndex !== page.pageIndex)) fail("CANDIDATE_PAGE_BINDING_INVALID");
      if (block.pageIndex === null) unknownBindings++;
      size += block.text.length;
      if (size > 6_000_000) fail("CANDIDATE_TOO_LARGE");
      return { ordinal: i + 1, kind: block.kind, text: block.text, pageIndex: block.pageIndex };
    });
    return { index: page.pageIndex, blocks };
  }).sort((a,b) => a.index - b.index);
  if (pages.some((p,i) => p.index !== i)) fail("CANDIDATE_PAGE_LAYOUT_INVALID");
  const ocr = raw.ocr;
  if (ocr !== undefined && (!plain(ocr) || typeof ocr.ocrModeRequested !== "boolean" ||
      ![true,false,null].includes(ocr.ocrEnabled) ||
      (ocr.engine !== null && (typeof ocr.engine !== "string" || ocr.engine.length > 120)) ||
      (ocr.pagesOcrSucceeded !== null && (!Number.isInteger(ocr.pagesOcrSucceeded) || ocr.pagesOcrSucceeded < 0)))) {
    fail("CANDIDATE_OCR_PROVENANCE_INVALID");
  }
  const ocrLabel = ocr === undefined ? "OCR 证据未提供" :
    ocr.ocrEnabled === true ? "上游声明 OCR 已启用" :
    ocr.ocrEnabled === false ? "上游声明 OCR 未启用" :
    ocr.ocrModeRequested ? "仅请求 OCR，上游启用状态未知" : "未请求 OCR，上游状态未知";
  return {
    fixtureId: expectedFixtureId,
    parser: raw.parser.name,
    version: raw.parser.version,
    mode: typeof raw.parser.mode === "string" ? raw.parser.mode.slice(0, 60) : "default",
    readingOrderAvailable: raw.readingOrderAvailable,
    unknownBindings,
    ocrLabel,
    engine: ocr?.engine ?? null,
    pages,
    sourceStatus: "UNVERIFIED_LOCAL_CANDIDATE",
  };
}

/** Seal the actual GT bytes before allowing comparison: not an audit certificate. */
export function sealBlindDraft(rawDraft) {
  const draft = parseDraft(rawDraft);
  return { fixtureId: draft.fixtureId, snapshot: JSON.stringify(draft), gt: buildGroundTruth(draft) };
}
export function requireSealedComparison(seal, rawDraft, candidate) {
  if (!seal || !plain(candidate) || !FIXTURES[candidate.fixtureId] ||
      candidate.fixtureId !== seal.fixtureId || candidate.sourceStatus !== "UNVERIFIED_LOCAL_CANDIDATE" ||
      JSON.stringify(parseDraft(rawDraft)) !== seal.snapshot) fail("BLIND_GT_SEAL_REQUIRED");
  return true;
}

/**
 * Stable monotonic exact normalized-block alignment (LCS, no inferred matches).
 * Unmatched rows are "requires human inspection", never an accuracy score.
 */
export function comparePage(seal, rawDraft, candidate, pageIndex) {
  requireSealedComparison(seal, rawDraft, candidate);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 2) fail("PAGE_INDEX_INVALID");
  const human = seal.gt.blocks.filter(b => b.page === pageIndex && normalizeText(b.text));
  const machine = candidate.pages[pageIndex].blocks.filter(b => normalizeText(b.text));
  if (human.length > MAX_COMPARE_BLOCKS || machine.length > MAX_COMPARE_BLOCKS) fail("COMPARE_TOO_MANY_BLOCKS");
  const a = human.map(b => normalizeText(b.text)), b = machine.map(x => normalizeText(x.text));
  const n = a.length, m = b.length;
  const table = Array.from({length:n+1},()=>new Uint16Array(m+1));
  for (let i=n-1;i>=0;i--) for (let j=m-1;j>=0;j--) {
    table[i][j] = a[i] === b[j] ? 1+table[i+1][j+1] : Math.max(table[i+1][j],table[i][j+1]);
  }
  const rows = [];
  let i=0,j=0;
  while(i<n || j<m){
    if(i<n && j<m && a[i]===b[j]){
      rows.push({status:"一致（仅文本）",humanId:human[i].id,humanText:human[i].text,
        candidateOrdinal:machine[j].ordinal,candidateText:machine[j].text,kind:machine[j].kind});i++;j++;
    }else if(i<n && (j===m || table[i+1][j]>=table[i][j+1])){
      rows.push({status:"人工有／候选未对齐",humanId:human[i].id,humanText:human[i].text,
        candidateOrdinal:null,candidateText:"",kind:null});i++;
    }else {
      rows.push({status:"候选有／人工未对齐",humanId:null,humanText:"",
        candidateOrdinal:machine[j].ordinal,candidateText:machine[j].text,kind:machine[j].kind});j++;
    }
  }
  return {pageIndex,sourcePage:FIXTURES[seal.fixtureId].originals[pageIndex],rows,
    note:"仅按 NFKC + 去空白匹配，不代表准确率或审核完成。顺序、未识别文本与 OCR 仍需逐段人工判断。"};
}

export function pdfPreviewEligibility(file, fixtureId, mapping) {
  if (!FIXTURES[fixtureId]) fail("FIXTURE_NOT_ALLOWLISTED");
  if (!file || typeof file.name !== "string" || !Number.isSafeInteger(file.size) || file.size < 8 || file.size > MAX_PDF_BYTES) fail("SOURCE_PDF_SIZE_INVALID");
  const source = FIXTURES[fixtureId].source;
  const expected = [source+".pdf"];
  if (mapping?.[source]?.displayName) expected.push(mapping[source].displayName);
  if (!expected.includes(file.name)) fail("SOURCE_PDF_FILENAME_MISMATCH");
  if (mapping?.[source]?.bytes && file.size !== mapping[source].bytes) fail("SOURCE_PDF_SIZE_MISMATCH");
  return {source,originalPhysicalPage:FIXTURES[fixtureId].originals[0],verifiedBySha:false};
}
