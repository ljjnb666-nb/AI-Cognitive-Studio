/**
 * Multi-region cloud graph review: strict, pure, offline, UNATTESTED human inspection.
 * NEVER promotes model proposals to verified GT, graph truth, or podcast input.
 */
export const REVIEW_SCHEMA = "acs-region-graph-review-draft-v1";
export const REVIEW_STATUS = "REVIEW_DRAFT_UNATTESTED";
export const CHOICES = Object.freeze(["UNREVIEWED", "VISIBLE_MATCH", "VISIBLE_MISMATCH", "UNCERTAIN"]);
export const MAX_RESULT_BYTES = 2_000_000;
export const MAX_MANIFEST_BYTES = 2_000_000;
export const MAX_CROP_BYTES = 8_000_000;
export const MAX_REVIEW_BYTES = 100_000;
const HASH = /^[0-9a-f]{64}$/u;
const NODE_ID = /^n[0-9]{1,3}$/u;
const EDGE_ID = /^e[0-9]{1,3}$/u;
const DIRS = new Set(["UNKNOWN", "FROM_TO_SUGGESTED", "TO_FROM_SUGGESTED"]);

const OBJECT = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => typeof value === "number" && Number.isFinite(value);
const hex = value => typeof value === "string" && HASH.test(value);
export class GraphReviewError extends Error {
  constructor(code) { super(code); this.code = code; this.name = "GraphReviewError"; }
}
function fail(code) { throw new GraphReviewError(code); }
function boundText(value, max) {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail("GRAPH_TEXT_INVALID");
  return value;
}
function coord(point, width, height) {
  return Array.isArray(point) && point.length === 2 && point.every(finite) &&
    point[0] >= 0 && point[0] < width && point[1] >= 0 && point[1] < height;
}
function rect(box, width, height) {
  return Array.isArray(box) && box.length === 4 && box.every(finite) &&
    box[0] >= 0 && box[1] >= 0 && box[2] > 0 && box[3] > 0 &&
    box[0] + box[2] <= width && box[1] + box[3] <= height;
}
function equalNumbers(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
    a.every((x,i) => finite(x) && x === b[i]);
}
const FIXTURE = /^RB-PDF-(?:12|13)$/u;
const REGION = /^page-[0-9]{3}-region-[0-9]{2}$/u;
export function validateRegionRegistration(reg) {
  if (!OBJECT(reg) || !FIXTURE.test(reg.fixtureId ?? "") ||
      !REGION.test(reg.regionId ?? "") ||
      !Number.isSafeInteger(reg.sourcePhysicalPage1Based) ||
      reg.sourcePhysicalPage1Based < 1 || reg.sourcePhysicalPage1Based > 5000 ||
      reg.sourceRun !== "real-mineru-39440805765-1" ||
      reg.provider !== "ZHIPU_GLMCLOUD_STANDARD_API" ||
      reg.model !== "glm-5.3-flash" ||
      typeof reg.attemptClass !== "string" ||
      !/^[A-Z][A-Z0-9_]{6,72}$/u.test(reg.attemptClass) ||
      (reg.expectedCropSha256 !== undefined && !hex(reg.expectedCropSha256)) ||
      (reg.expectedResultSha256 !== undefined && !hex(reg.expectedResultSha256)))
    fail("REGION_GRAPH_REGISTRATION_INVALID");
  return Object.freeze({
    fixtureId:reg.fixtureId,regionId:reg.regionId,
    sourcePhysicalPage1Based:reg.sourcePhysicalPage1Based,
    sourceRun:reg.sourceRun,provider:reg.provider,model:reg.model,
    attemptClass:reg.attemptClass,
    expectedCropSha256:reg.expectedCropSha256 ?? null,
    expectedResultSha256:reg.expectedResultSha256 ?? null,
  });
}
export function validateRegionGraphCandidate(doc, manifest, identity, registration) {
  const reg = validateRegionRegistration(registration);
  if (reg.expectedCropSha256 && identity?.cropSha256 !== reg.expectedCropSha256)
    fail("REGION_GRAPH_PINNED_CROP_MISMATCH");
  if (reg.expectedResultSha256 && identity?.resultSha256 !== reg.expectedResultSha256)
    fail("REGION_GRAPH_PINNED_RESULT_MISMATCH");
  if (!OBJECT(doc) || !OBJECT(manifest) || !OBJECT(identity)) fail("GRAPH_INPUT_INVALID");
  if (![identity.manifestSha256, identity.cropSha256, identity.resultSha256].every(hex)) fail("GRAPH_SOURCE_SHA_MISSING");
  if (doc.schemaVersion !== "acs-glm-cloud-vision-proposal-v1" ||
      doc.sourceRun !== reg.sourceRun ||
      doc.fixtureId !== reg.fixtureId ||
      doc.provider !== reg.provider ||
      doc.model !== reg.model ||
      doc.attemptClass !== reg.attemptClass ||
      doc.sourceRegionManifestSha256 !== identity.manifestSha256 ||
      doc.reviewStatus !== "NOT_REVIEWED" || doc.graphVerified !== false ||
      doc.transferScope !== "EXPLICITLY_SELECTED_CROP_IMAGES_ONLY" ||
      !Array.isArray(doc.results) || doc.results.length !== 1) fail("GRAPH_RESULT_IDENTITY_MISMATCH");
  if (manifest.schemaVersion !== "acs-pdf-private-region-evidence-v1" ||
      manifest.sourceRun !== doc.sourceRun || manifest.fixtureId !== doc.fixtureId ||
      manifest.allRegionsAreUnverified !== true || manifest.noSemanticGraphClaims !== true ||
      !Array.isArray(manifest.pages) || manifest.pages.length > 3) fail("GRAPH_MANIFEST_INVALID");
  const regionCandidates = [], seenPages = new Set(), seenRegions = new Set();
  for (const page of manifest.pages) {
    if (!OBJECT(page) || !Array.isArray(page.regions) || page.regions.length > 4 ||
        !Number.isSafeInteger(page.subsetPageIndex) ||
        page.subsetPageIndex < 0 || page.subsetPageIndex > 2 ||
        seenPages.has(page.subsetPageIndex) ||
        !Number.isSafeInteger(page.sourcePhysicalPage1Based) ||
        page.sourcePhysicalPage1Based < 1 || page.sourcePhysicalPage1Based > 5000)
      fail("REGION_GRAPH_MANIFEST_PAGE_INVALID");
    seenPages.add(page.subsetPageIndex);
    for (const [i,region] of page.regions.entries()) {
      if (!OBJECT(region) || typeof region.regionId !== "string" ||
          region.regionId !== "page-"+String(page.subsetPageIndex+1).padStart(3,"0")+
             "-region-"+String(i+1).padStart(2,"0") ||
          seenRegions.has(region.regionId) ||
          region.proposalStatus !== "UNVERIFIED_REGION_SUGGESTION" ||
          region.nodes != null || region.directedEdges != null ||
          region.timingRelations != null)
        fail("REGION_GRAPH_MANIFEST_REGION_INVALID");
      seenRegions.add(region.regionId);
      if (region.regionId === reg.regionId) regionCandidates.push({page,region});
    }
  }
  if (regionCandidates.length !== 1) fail("GRAPH_REGION_NOT_UNIQUE");
  const {page,region} = regionCandidates[0];
  const box = region.bboxPixels;
  if (page.sourcePhysicalPage1Based !== reg.sourcePhysicalPage1Based ||
      region.proposalStatus !== "UNVERIFIED_REGION_SUGGESTION" ||
      region.nodes != null || region.directedEdges != null || region.timingRelations != null ||
      !hex(region.cropSha256) || region.cropSha256 !== identity.cropSha256 ||
      !Array.isArray(box) || box.length !== 4 ||
      !box.every(x => Number.isSafeInteger(x)) || box[0] < 0 || box[1] < 0 ||
      box[2] < 20 || box[3] < 20 ||
      identity.cropWidth !== box[2] || identity.cropHeight !== box[3]) fail("GRAPH_CROP_EVIDENCE_MISMATCH");
  const [x0,y0,width,height] = box;
  const row = doc.results[0], p = row?.proposal, mapped = row?.mappedPageEvidence;
  if (!OBJECT(row) || !OBJECT(p) || !OBJECT(mapped) ||
      row.regionId !== region.regionId || row.sourcePhysicalPage1Based !== reg.sourcePhysicalPage1Based ||
      row.cropSha256 !== identity.cropSha256 ||
      row.humanReviewStatus !== "NOT_REVIEWED" || row.graphVerified !== false ||
      p.schemaVersion !== "acs-vision-graph-proposal-v1" ||
      p.fixtureId !== doc.fixtureId || p.regionId !== region.regionId ||
      p.sourceCropSha256 !== identity.cropSha256 ||
      p.coordinateSpace !== "REGION_CROP_TOP_LEFT_PIXELS" ||
      p.graphStatus !== "PROPOSED_UNVERIFIED" || p.reviewStatus !== "NOT_REVIEWED" ||
      p.humanVerified !== false || !Array.isArray(p.nodes) || !Array.isArray(p.edges) ||
      p.nodes.length > 80 || p.edges.length > 120 ||
      mapped.regionId !== region.regionId ||
      mapped.sourcePhysicalPage1Based !== reg.sourcePhysicalPage1Based ||
      mapped.sourceCropSha256 !== identity.cropSha256 ||
      mapped.graphVerified !== false || mapped.needsIndependentHumanReview !== true ||
      !Array.isArray(mapped.mappedNodes) || !Array.isArray(mapped.mappedEdges) ||
      mapped.mappedNodes.length !== p.nodes.length ||
      mapped.mappedEdges.length !== p.edges.length) fail("GRAPH_UNVERIFIED_CONTRACT_INVALID");
  const ids = new Set();
  const nodes = p.nodes.map((node,i) => {
    const m = mapped.mappedNodes[i];
    if (!OBJECT(node) || !OBJECT(m) || !NODE_ID.test(node.id ?? "") || ids.has(node.id) ||
        !rect(node.bboxCropPixels,width,height) ||
        !finite(node.proposalConfidence) || node.proposalConfidence < 0 || node.proposalConfidence > 1 ||
        node.reviewStatus !== "NOT_REVIEWED" ||
        m.id !== node.id || m.sourcePhysicalPage1Based !== reg.sourcePhysicalPage1Based ||
        m.claim !== "MACHINE_SUGGESTION_NOT_VERIFIED" ||
        !equalNumbers(m.bboxPagePixels,[x0+node.bboxCropPixels[0],y0+node.bboxCropPixels[1],node.bboxCropPixels[2],node.bboxCropPixels[3]]))
      fail("GRAPH_NODE_OR_MAPPING_INVALID");
    ids.add(node.id);
    return Object.freeze({ id:node.id,label:boundText(node.label,160),
      box:node.bboxCropPixels.slice(),confidence:node.proposalConfidence });
  });
  const edgeIds = new Set();
  const edges = p.edges.map((edge,i) => {
    const m = mapped.mappedEdges[i];
    if (!OBJECT(edge) || !OBJECT(m) || !EDGE_ID.test(edge.id ?? "") || edgeIds.has(edge.id) ||
        !ids.has(edge.fromNodeId) || !ids.has(edge.toNodeId) ||
        edge.fromNodeId === edge.toNodeId || !DIRS.has(edge.direction) ||
        !coord(edge.arrowTipCropPixels,width,height) ||
        !Array.isArray(edge.shaftCropPixels) || edge.shaftCropPixels.length !== 2 ||
        !edge.shaftCropPixels.every(pt => coord(pt,width,height)) ||
        !finite(edge.proposalConfidence) || edge.proposalConfidence < 0 || edge.proposalConfidence > 1 ||
        edge.reviewStatus !== "NOT_REVIEWED" ||
        m.id !== edge.id || m.sourcePhysicalPage1Based !== reg.sourcePhysicalPage1Based ||
        m.claim !== "GEOMETRIC_WITNESS_AND_RELATION_UNVERIFIED" ||
        !equalNumbers(m.arrowTipPagePixels,[x0+edge.arrowTipCropPixels[0],y0+edge.arrowTipCropPixels[1]]) ||
        !Array.isArray(m.shaftPagePixels) || m.shaftPagePixels.length !== 2 ||
        !m.shaftPagePixels.every((pt,j) => equalNumbers(pt,[x0+edge.shaftCropPixels[j][0],y0+edge.shaftCropPixels[j][1]])))
      fail("GRAPH_EDGE_OR_MAPPING_INVALID");
    edgeIds.add(edge.id);
    return Object.freeze({id:edge.id,from:edge.fromNodeId,to:edge.toNodeId,
      direction:edge.direction,tip:edge.arrowTipCropPixels.slice(),
      shaft:edge.shaftCropPixels.map(pt=>pt.slice()),confidence:edge.proposalConfidence});
  });
  return Object.freeze({
    fixtureId:reg.fixtureId,physicalPage:reg.sourcePhysicalPage1Based,regionId:region.regionId,
    cropSha256:identity.cropSha256,manifestSha256:identity.manifestSha256,
    resultSha256:identity.resultSha256,width,height,offset:[x0,y0],
    nodes,edges,graphVerified:false,reviewStatus:"NOT_REVIEWED",
  });
}
export function createRegionReviewDraft(view) {
  if (!OBJECT(view) || !FIXTURE.test(view.fixtureId ?? "") ||
      !REGION.test(view.regionId ?? "") ||
      !Number.isSafeInteger(view.physicalPage) || view.physicalPage < 1 ||
      view.physicalPage > 5000 ||
      ![view.resultSha256,view.cropSha256,view.manifestSha256].every(hex) ||
      view.graphVerified !== false || view.reviewStatus !== "NOT_REVIEWED" ||
      !Array.isArray(view.nodes) || !Array.isArray(view.edges) ||
      view.nodes.length > 80 || view.edges.length > 120)
    fail("GRAPH_VIEW_INVALID");
  return { schema:REVIEW_SCHEMA,status:REVIEW_STATUS,
    resultSha256:view.resultSha256,cropSha256:view.cropSha256,manifestSha256:view.manifestSha256,
    fixtureId:view.fixtureId,physicalPage:view.physicalPage,regionId:view.regionId,
    humanVerified:false,graphVerified:false,
    decisions:[
      ...view.nodes.map(n=>({kind:"node",id:n.id,decision:"UNREVIEWED",note:""})),
      ...view.edges.map(e=>({kind:"edge",id:e.id,decision:"UNREVIEWED",note:""})),
    ],
  };
}
export function parseRegionReviewDraft(raw,view) {
  const base=createRegionReviewDraft(view);
  if (!OBJECT(raw) || raw.schema !== base.schema || raw.status !== REVIEW_STATUS ||
      raw.resultSha256 !== base.resultSha256 || raw.cropSha256 !== base.cropSha256 ||
      raw.manifestSha256 !== base.manifestSha256 || raw.fixtureId !== base.fixtureId ||
      raw.physicalPage !== base.physicalPage || raw.regionId !== base.regionId ||
      raw.graphVerified !== false || raw.humanVerified !== false ||
      !Array.isArray(raw.decisions) || raw.decisions.length !== base.decisions.length) fail("GRAPH_REVIEW_LINEAGE_INVALID");
  const expected = new Map(base.decisions.map(d=>[d.kind+":"+d.id,d]));
  const seen = new Set();
  for (const d of raw.decisions) {
    if (!OBJECT(d) || !["node","edge"].includes(d.kind) || typeof d.id !== "string" ||
        !expected.has(d.kind+":"+d.id) || seen.has(d.kind+":"+d.id) ||
        !CHOICES.includes(d.decision)) fail("GRAPH_DECISION_INVALID");
    const note=boundText(d.note,280);
    if (d.decision === "UNREVIEWED" && note) fail("GRAPH_DECISION_INVALID");
    expected.set(d.kind+":"+d.id,{kind:d.kind,id:d.id,decision:d.decision,note});
    seen.add(d.kind+":"+d.id);
  }
  return {...base, decisions:base.decisions.map(d=>expected.get(d.kind+":"+d.id))};
}
export function updateRegionReviewDraft(raw, view, kind, id, decision, note = "") {
  const draft=parseRegionReviewDraft(raw,view);
  const key=kind+":"+id;
  if (!draft.decisions.some(d=>d.kind+":"+d.id===key) || !CHOICES.includes(decision)) fail("GRAPH_DECISION_INVALID");
  const text=boundText(note,280);
  if (decision === "UNREVIEWED" && text) fail("GRAPH_DECISION_INVALID");
  draft.decisions=draft.decisions.map(d=>d.kind+":"+d.id===key?{kind,id,decision,note:text}:d);
  return draft;
}
export function regionReviewProgress(raw,view) {
  const draft=parseRegionReviewDraft(raw,view);
  const counts={total:draft.decisions.length,reviewed:0,match:0,mismatch:0,uncertain:0,unreviewed:0};
  for (const d of draft.decisions) {
    if (d.decision === "UNREVIEWED") counts.unreviewed++;
    else { counts.reviewed++; if (d.decision === "VISIBLE_MATCH") counts.match++;
      else if (d.decision === "VISIBLE_MISMATCH") counts.mismatch++; else counts.uncertain++; }
  }
  return {...counts, status:REVIEW_STATUS,certified:false};
}

export function regionReviewDraftFilename(view) {
  const base=createRegionReviewDraft(view);
  return base.fixtureId+"-"+base.regionId+"-"+base.resultSha256+"-DRAFT-UNATTESTED.json";
}
