import { describe, expect, it } from 'vitest';
import { evaluateStructureEvidence, STRUCTURE_EVIDENCE_VERSION } from '../src/structure/evidence.mjs';

// All cases are synthetic; never commit real PDF, OCR, GT, labels or text.
const element = (id, kind, text) => ({ id, kind, text });
const ref = (elements, relations = [], linearOrder = [], physical = 51) => ({
  schemaVersion: 'acs-pdf-structure-reference-v1', fixtureId: 'SYN-STRUCT-01', sourcePages1Based: [physical],
  pages: [{ subsetPageIndex: 0, sourcePhysicalPage: physical, elements, relations, linearOrder }],
});
const out = (blocks, pageMarkers) => ({ fixtureId: 'SYN-STRUCT-01', parser: { name: 'synthetic', version: '1' },
  pages: [{ pageIndex: 0, blocks: blocks.map((b) => ({ kind: b.kind ?? 'paragraph', text: b.text, pageIndex: b.pageIndex === undefined ? 0 : b.pageIndex })) }],
  ...(pageMarkers && { pageMarkers }) });
const evalFirst = (reference, normalized) => evaluateStructureEvidence({ reference, normalized }).pages[0];

describe('PDF-STRUCTURE-01: fail-closed structural evidence', () => {
  it('separates recovered figure labels from unsupported arrow semantics', () => {
    const reference = ref([element('a','figure_label','购买'),element('b','figure_label','托运')],[{id:'arrow1',kind:'FLOW',from:'a',to:'b'}]);
    const report = evaluateStructureEvidence({ reference, normalized: out([{text:'购买 托运'}]) });
    expect(report.version).toBe(STRUCTURE_EVIDENCE_VERSION);
    expect(report.pages[0].textEvidence.map((e) => e.status)).toEqual(['FLATTENED_TEXT_PRESENT','FLATTENED_TEXT_PRESENT']);
    expect(report.pages[0].relations[0].status).toBe('NOT_VERIFIABLE_FROM_NORMALIZED');
    expect(report.score).toBeNull();
  });
  it('does not treat an OCR text match as a typed code or figure block', () => {
    const reference = ref([element('c','code','response = conn.recv()')]);
    expect(evalFirst(reference,out([{text:'response = conn.recv()',kind:'paragraph'}])).textEvidence[0].status).toBe('FLATTENED_TEXT_PRESENT');
    expect(evalFirst(reference,out([{text:'response = conn.recv()',kind:'code'}])).textEvidence[0].status).toBe('TYPED_TEXT_PRESENT');
  });
  it('checks linear body-anchor order without pretending to check diagram geometry', () => {
    const reference = ref([element('a','paragraph','上一段'),element('b','paragraph','下一段')],[],['a','b']);
    const result = evalFirst(reference,out([{text:'下一段。上一段。'}]));
    expect(result.linearOrder.observedPairAccuracy).toBe(0);
    expect(result.linearOrder.complete).toBe(true);
  });
  it('never scores partial reading order as complete', () => {
    const reference = ref([element('a','paragraph','上一段'),element('b','paragraph','下一段')],[],['a','b']);
    const result = evalFirst(reference,out([{text:'上一段'}]));
    expect(result.linearOrder.observedPairAccuracy).toBeNull();
    expect(result.linearOrder.complete).toBe(false);
  });
  it('prevents duplicate text anchors from generating false location certainty', () => {
    const reference = ref([element('a','paragraph','重复标签')],[],['a']);
    const result = evalFirst(reference,out([{text:'重复标签 重复标签'}]));
    expect(result.textEvidence[0].status).toBe('AMBIGUOUS');
  });
  it('rejects document-level or null-page blocks as bound pages', () => {
    const reference = ref([element('a','figure_label','甲')]);
    const result = evalFirst(reference,out([{text:'甲',pageIndex:null}]));
    expect(result.status).toBe('PAGE_BINDING_UNVERIFIED');
    expect(result.textEvidence).toBeNull();
  });
  it('rejects missing page marker provenance even when index fields are populated', () => {
    const reference = ref([element('a','figure_label','甲')]);
    const result = evalFirst(reference,out([{text:'甲'}],{status:'MISSING',declaredTotalPages:1,source:'synthetic'}));
    expect(result.status).toBe('PAGE_BINDING_UNVERIFIED');
  });
  it('requires explicit verified page markers for MinerU legacy outputs', () => {
    const reference = ref([element('a','figure_label','甲')]);
    const candidate = out([{text:'甲'}]); candidate.parser.name = 'mineru';
    expect(evalFirst(reference,candidate).status).toBe('PAGE_BINDING_UNVERIFIED');
    candidate.pageMarkers = {status:'VALID',declaredTotalPages:1,source:'synthetic'};
    expect(evalFirst(reference,candidate).status).toBe('TEXT_EVIDENCE_ONLY');
  });
  it('rejects unsupported source-physical-page mapping', () => {
    const reference = ref([element('a','paragraph','甲')]);
    reference.pages[0].sourcePhysicalPage = 127;
    expect(() => evalFirst(reference,out([{text:'甲'}]))).toThrow(/PHYSICAL_MAPPING/);
  });
  it('rejects references to unrecognized elements or duplicated IDs', () => {
    const badRelation = ref([element('a','figure_label','甲')],[{id:'r1',from:'a',to:'missing',kind:'FLOW'}]);
    expect(() => evalFirst(badRelation,out([{text:'甲'}]))).toThrow(/RELATION/);
    const badElement = ref([element('a','paragraph','甲'),element('a','paragraph','乙')]);
    expect(() => evalFirst(badElement,out([{text:'甲乙'}]))).toThrow(/ELEMENT_ID/);
  });
  it('rejects another fixture or duplicate normalized page containers', () => {
    const reference = ref([element('a','paragraph','甲')]);
    const notSameFixture = out([{text:'甲'}]); notSameFixture.fixtureId = 'OTHER';
    expect(() => evalFirst(reference,notSameFixture)).toThrow(/NORMALIZED_FIXTURE/);
    const duplicated = out([{text:'甲'}]); duplicated.pages.push(duplicated.pages[0]);
    expect(() => evalFirst(reference,duplicated)).toThrow(/NORMALIZED_PAGE/);
  });
  it('does not invent text evidence for absent output pages', () => {
    const reference = ref([element('a','paragraph','甲')]);
    const output = out([{text:'甲'}]); output.pages = [];
    expect(evalFirst(reference,output).status).toBe('MISSING_OUTPUT_PAGE');
  });
  it('does not infer diagram topology from labeled sequence text', () => {
    const reference = ref([element('s','figure_label','发起请求'),element('t','figure_label','返回响应')],[{id:'arrow1',kind:'MESSAGE',from:'s',to:'t'}]);
    const result = evalFirst(reference,out([{text:'发起请求 返回响应',kind:'figure'}]));
    expect(result.relations[0].status).toBe('NOT_VERIFIABLE_FROM_NORMALIZED');
    expect(result.diagramStructure).toBe('NOT_VERIFIABLE_FROM_NORMALIZED');
  });
});
