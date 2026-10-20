/**
 * PDF-STRUCTURE-01: deterministic, evidence-only inspection of normalized parser
 * output against a separately prepared page/structure reference.
 *
 * It does NOT infer diagrams, arrows, image regions, or a model's understanding
 * from flattened text. It never computes an overall score or a parser winner.
 * Keep private references and normalized real-book outputs outside Git.
 */
export const STRUCTURE_EVIDENCE_VERSION = 'acs-pdf-structure-evidence-v1';

const KINDS = new Set(['paragraph', 'heading', 'caption', 'figure_label', 'code', 'table', 'formula']);
const TYPED_KINDS = {
  paragraph: new Set(['paragraph', 'text', 'para', 'body']),
  heading: new Set(['heading', 'title', 'section-header']),
  caption: new Set(['caption']),
  figure_label: new Set(['figure_label']),
  code: new Set(['code']),
  table: new Set(['table']),
  formula: new Set(['equation', 'formula']),
};
const isIndex = (n) => Number.isSafeInteger(n) && n >= 0;
const normalizedText = (s) => s.normalize('NFKC').replace(/\s/gu, '');
const requireThat = (ok, code) => { if (!ok) throw new Error(`STRUCTURE_REFERENCE_INVALID:${code}`); };

function checkReference(reference) {
  requireThat(reference && typeof reference === 'object' && !Array.isArray(reference), 'ROOT');
  requireThat(reference.schemaVersion === 'acs-pdf-structure-reference-v1', 'VERSION');
  requireThat(typeof reference.fixtureId === 'string' && reference.fixtureId.length > 0, 'FIXTURE');
  const map = reference.sourcePages1Based;
  requireThat(Array.isArray(map) && map.length > 0 && map.length <= 5000 && map.every((n) => isIndex(n) && n > 0) && new Set(map).size === map.length, 'SOURCE_PAGES');
  requireThat(Array.isArray(reference.pages) && reference.pages.length > 0 && reference.pages.length <= map.length, 'PAGES');
  const pageIds = new Set();
  for (const page of reference.pages) {
    requireThat(page && isIndex(page.subsetPageIndex) && page.subsetPageIndex < map.length && !pageIds.has(page.subsetPageIndex), 'PAGE_INDEX');
    pageIds.add(page.subsetPageIndex);
    requireThat(page.sourcePhysicalPage === map[page.subsetPageIndex], 'PHYSICAL_MAPPING');
    requireThat(Array.isArray(page.elements) && page.elements.length <= 500 && Array.isArray(page.relations) && page.relations.length <= 500, 'ELEMENT_LIMIT');
    const ids = new Set();
    for (const el of page.elements) {
      requireThat(el && typeof el.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(el.id) && !ids.has(el.id), 'ELEMENT_ID');
      ids.add(el.id);
      requireThat(KINDS.has(el.kind) && typeof el.text === 'string' && el.text.length > 0 && el.text.length <= 2000 && normalizedText(el.text).length > 0, 'ELEMENT_TEXT');
    }
    requireThat(Array.isArray(page.linearOrder) && new Set(page.linearOrder).size === page.linearOrder.length && page.linearOrder.every((id) => ids.has(id)), 'LINEAR_ORDER');
    for (const rel of page.relations) {
      requireThat(rel && typeof rel.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(rel.id) && ids.has(rel.from) && ids.has(rel.to) && rel.from !== rel.to && typeof rel.kind === 'string' && rel.kind.length > 0 && rel.kind.length <= 80, 'RELATION');
    }
  }
}

function checkNormalized(output, fixtureId) {
  requireThat(output && output.fixtureId === fixtureId && Array.isArray(output.pages) && output.pages.length <= 5000, 'NORMALIZED_FIXTURE');
  const ids = new Set();
  for (const page of output.pages) {
    requireThat(page && isIndex(page.pageIndex) && !ids.has(page.pageIndex) && Array.isArray(page.blocks), 'NORMALIZED_PAGE');
    ids.add(page.pageIndex);
    requireThat(page.blocks.length <= 200_000 && page.blocks.every((b) => b && typeof b.text === 'string' && typeof b.kind === 'string'), 'NORMALIZED_BLOCK');
  }
}

function occurrences(text, anchor) {
  let found = -1;
  let count = 0;
  let position = null;
  while ((found = text.indexOf(anchor, found + 1)) !== -1) {
    if (++count === 1) position = found;
    if (count > 1) break;
  }
  return { count, position: count === 1 ? position : null };
}

function gradeLinearOrder(order, elementPositions) {
  let comparable = 0;
  let correct = 0;
  let missing = 0;
  for (const id of order) if (elementPositions.get(id) === null) missing++;
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      const a = elementPositions.get(order[i]);
      const b = elementPositions.get(order[j]);
      if (a === null || b === null || a === b) continue;
      comparable++;
      if (a < b) correct++;
    }
  }
  // Pair accuracy among visible, unambiguous anchors is NOT full-page accuracy.
  return { expectedAnchors: order.length, missingOrAmbiguousAnchors: missing, comparablePairs: comparable, correctPairs: correct,
    observedPairAccuracy: comparable > 0 ? correct / comparable : null, complete: missing === 0 && comparable === order.length * (order.length - 1) / 2 };
}

/**
 * @param {{reference:object,normalized:object}} input
 * @returns {object} JSON-serializable evidence. Page indexes are subset-local.
 */
export function evaluateStructureEvidence({ reference, normalized }) {
  checkReference(reference);
  checkNormalized(normalized, reference.fixtureId);
  const byPage = new Map(normalized.pages.map((page) => [page.pageIndex, page]));
  const pages = [];
  for (const refPage of reference.pages) {
    const page = byPage.get(refPage.subsetPageIndex);
    const pageBound = !!page && page.blocks.length > 0 && normalized.pageMarkers?.status !== 'MISSING' &&
      page.blocks.every((block) => block.pageIndex === refPage.subsetPageIndex);
    const status = !page ? 'MISSING_OUTPUT_PAGE' : !pageBound ? 'PAGE_BINDING_UNVERIFIED' : 'TEXT_EVIDENCE_ONLY';
    if (!pageBound) {
      pages.push({ subsetPageIndex: refPage.subsetPageIndex, sourcePhysicalPage: refPage.sourcePhysicalPage,
        status, textEvidence: null, linearOrder: null,
        relations: refPage.relations.map((rel) => ({ id: rel.id, status: 'NOT_VERIFIABLE_FROM_NORMALIZED' })),
        diagramStructure: 'NOT_VERIFIABLE_FROM_NORMALIZED' });
      continue;
    }
    const fullText = normalizedText(page.blocks.map((block) => block.text).join(''));
    const positions = new Map();
    const textEvidence = refPage.elements.map((element) => {
      const needle = normalizedText(element.text);
      const { count, position } = occurrences(fullText, needle);
      positions.set(element.id, position);
      const exactTypedBlock = page.blocks.some((block) => TYPED_KINDS[element.kind].has(block.kind.toLowerCase()) && normalizedText(block.text).includes(needle));
      return { id: element.id, kind: element.kind,
        status: count === 0 ? 'MISSING' : count > 1 ? 'AMBIGUOUS' : exactTypedBlock ? 'TYPED_TEXT_PRESENT' : 'FLATTENED_TEXT_PRESENT',
        // A typed caption/code block is still not diagram topology evidence.
        textOccurrenceCount: Math.min(count, 2) };
    });
    pages.push({ subsetPageIndex: refPage.subsetPageIndex, sourcePhysicalPage: refPage.sourcePhysicalPage,
      status, textEvidence, linearOrder: gradeLinearOrder(refPage.linearOrder, positions),
      relations: refPage.relations.map((rel) => ({ id: rel.id, status: 'NOT_VERIFIABLE_FROM_NORMALIZED' })),
      diagramStructure: 'NOT_VERIFIABLE_FROM_NORMALIZED' });
  }
  return { version: STRUCTURE_EVIDENCE_VERSION, fixtureId: reference.fixtureId,
    // Never infer a source book page from a subset page index or MinerU markdown comment.
    pages, score: null, parserWinner: null };
}
