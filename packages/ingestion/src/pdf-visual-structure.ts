import { createHash } from "node:crypto";
import { renderPdfMixedPageSourcePreviews, type PdfMixedPageSourcePreview } from "./pdf-mixed-page-preview.js";
import type { ParserLimits } from "./document-parsers.js";

/**
 * Vision is supplemental evidence, NOT a canonical text writer or Gold grader.
 * This schema intentionally cannot return OCR paragraphs or publication state.
 */
export const PDF_VISUAL_STRUCTURE_VERSION = "pdf-visual-structure-v1" as const;
export const PDF_VISUAL_STRUCTURE_AUTHORITY = "UNVERIFIED_VISUAL_CANDIDATE" as const;

export type VisualShape = "CHART" | "DIAGRAM" | "TABLE" | "ILLUSTRATION";
export type VisualNode = { id: string; label: string };
export type VisualEdge = { from: string; to: string; label: string; direction: "DIRECTED" | "BIDIRECTIONAL" | "UNDIRECTED" };
export type VisualFigureCandidate = {
  id: string;
  kind: VisualShape;
  /** Integer thousandth-of-page geometry, top-left origin. */
  bbox: [number,number,number,number];
  caption: string;
  nodes: VisualNode[];
  edges: VisualEdge[];
};
export type VisualPageInput = Pick<PdfMixedPageSourcePreview,
  "physicalPageIndex" | "sourceSha256" | "pngSha256" | "pngBytes" | "width" | "height">;
export type VisualPageExecutor = {
  inspect(input: VisualPageInput & {signal?: AbortSignal}): Promise<unknown>;
};
export type VisualPageReview = {
  physicalPageIndex: number;
  sourceSha256: string;
  pngSha256: string;
  authority: typeof PDF_VISUAL_STRUCTURE_AUTHORITY;
  figureSemantics: "UNVERIFIED";
  status: "CANDIDATE_AVAILABLE" | "REVIEW_REQUIRED";
  figures: VisualFigureCandidate[];
  failureReason?: "VISION_REJECTED" | "INVALID_STRUCTURE";
};
export type PdfVisualStructureResult = {
  schemaVersion: typeof PDF_VISUAL_STRUCTURE_VERSION;
  authority: typeof PDF_VISUAL_STRUCTURE_AUTHORITY;
  pageCount: number;
  mixedPageCount: number;
  examinedPageCount: number;
  pages: VisualPageReview[];
  nativeTextUnchanged: true;
  productionRoutingChanged: false;
  goldApproved: false;
};
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const isRecord=(v:unknown):v is Record<string,unknown> =>
  typeof v==="object" && v!==null && !Array.isArray(v);
const keys=(v:Record<string,unknown>,allowed:readonly string[]) =>
  Object.keys(v).length===allowed.length && allowed.every(k=>Object.hasOwn(v,k));
const clean=(v:unknown,max:number):v is string =>
  typeof v==="string" && v.length<=max && !Array.from(v).some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127);
const name=(v:unknown):v is string => clean(v,48) && /^[A-Za-z0-9_-]{1,48}$/.test(v);
function parseGraph(value:unknown):VisualFigureCandidate[] {
  if (!isRecord(value) || !keys(value,["schemaVersion","figures"]) ||
      value.schemaVersion!==1 || !Array.isArray(value.figures) ||
      value.figures.length>8) throw new Error("VISUAL_STRUCTURE_REJECTED");
  const figures:VisualFigureCandidate[]=[];
  const seen=new Set<string>();
  for(const raw of value.figures) {
    if(!isRecord(raw)||!keys(raw,["id","kind","bbox","caption","nodes","edges"]) ||
       !name(raw.id)||seen.has(raw.id)||!["CHART","DIAGRAM","TABLE","ILLUSTRATION"].includes(String(raw.kind))||
       !clean(raw.caption,240)||!Array.isArray(raw.bbox)||raw.bbox.length!==4||
       !raw.bbox.every(n=>Number.isSafeInteger(n)&&n>=0&&n<=1000) ||
       (raw.bbox[0] as number)+(raw.bbox[2] as number)>1000||
       (raw.bbox[1] as number)+(raw.bbox[3] as number)>1000||
       (raw.bbox[2] as number)<1||(raw.bbox[3] as number)<1||
       !Array.isArray(raw.nodes)||raw.nodes.length>32||
       !Array.isArray(raw.edges)||raw.edges.length>48) throw new Error("VISUAL_STRUCTURE_REJECTED");
    seen.add(raw.id);
    const nodes:VisualNode[]=[];
    const ids=new Set<string>();
    for(const node of raw.nodes) {
      if(!isRecord(node)||!keys(node,["id","label"])||!name(node.id)||ids.has(node.id)||
         !clean(node.label,160)) throw new Error("VISUAL_STRUCTURE_REJECTED");
      ids.add(node.id);nodes.push({id:node.id,label:node.label});
    }
    const edges:VisualEdge[]=[];
    for(const edge of raw.edges) {
      if(!isRecord(edge)||!keys(edge,["from","to","label","direction"])||
        !name(edge.from)||!name(edge.to)||!ids.has(edge.from)||!ids.has(edge.to)||
        !clean(edge.label,160)||!["DIRECTED","BIDIRECTIONAL","UNDIRECTED"].includes(String(edge.direction)))
        throw new Error("VISUAL_STRUCTURE_REJECTED");
      edges.push({from:edge.from,to:edge.to,label:edge.label,
        direction:edge.direction as VisualEdge["direction"]});
    }
    figures.push({id:raw.id,kind:raw.kind as VisualShape,bbox:raw.bbox as VisualFigureCandidate["bbox"],
      caption:raw.caption,nodes,edges});
  }
  return figures;
}
/** Pure validation is exposed so provider-independent fixtures can be tested. */
export function validatePdfVisualStructureCandidate(value:unknown):VisualFigureCandidate[] {
  return parseGraph(value);
}
export type PdfVisualStructureOptions = {
  enabled:true;
  executor:VisualPageExecutor;
  maxPages?:number;
  signal?:AbortSignal;
};
/**
 * Actual PDF -> isolated PDF.js raster -> opt-in VLM -> guarded structure.
 * All model output is quarantined as unverified candidate. Failure is
 * review-required (NOT silently assumed empty figure), text route untouched.
 */
export async function inspectPdfMixedPageVisualStructure(
  pdfBytes:Uint8Array, limits:ParserLimits, options:PdfVisualStructureOptions,
):Promise<PdfVisualStructureResult> {
  if(options.enabled!==true||!options.executor||typeof options.executor.inspect!=="function"||
     (options.maxPages!==undefined&&(!Number.isSafeInteger(options.maxPages)||options.maxPages<1||options.maxPages>3)))
    throw new Error("VISUAL_STRUCTURE_OPTIONS_REJECTED");
  if(options.signal?.aborted)throw new Error("VISUAL_STRUCTURE_ABORTED");
  const sourceSha=digest(pdfBytes);
  const rendered=await renderPdfMixedPageSourcePreviews(pdfBytes,limits,
    {enabled:true,maxPreviewPages:options.maxPages??2});
  const pages:VisualPageReview[]=[];
  for(const image of rendered.previews) {
    if(options.signal?.aborted)throw new Error("VISUAL_STRUCTURE_ABORTED");
    if(image.sourceSha256!==sourceSha||image.pngSha256!==digest(image.pngBytes))
      throw new Error("VISUAL_STRUCTURE_SOURCE_CONFLICT");
    let figures:VisualFigureCandidate[]=[];
    let failureReason:VisualPageReview["failureReason"];
    try {
      const response=await options.executor.inspect({
        physicalPageIndex:image.physicalPageIndex,sourceSha256:image.sourceSha256,
        pngSha256:image.pngSha256,pngBytes:image.pngBytes,width:image.width,height:image.height,
        ...(options.signal?{signal:options.signal}:{})
      });
      if(options.signal?.aborted)throw new Error("VISUAL_STRUCTURE_ABORTED");
      figures=parseGraph(response);
    } catch(error) {
      if(options.signal?.aborted)throw new Error("VISUAL_STRUCTURE_ABORTED");
      failureReason=error instanceof Error&&error.message==="VISUAL_STRUCTURE_REJECTED"
        ? "INVALID_STRUCTURE":"VISION_REJECTED";
    }
    pages.push({
      physicalPageIndex:image.physicalPageIndex,
      sourceSha256:image.sourceSha256,pngSha256:image.pngSha256,
      authority:PDF_VISUAL_STRUCTURE_AUTHORITY,figureSemantics:"UNVERIFIED",
      status:failureReason?"REVIEW_REQUIRED":"CANDIDATE_AVAILABLE",
      figures,
      ...(failureReason?{failureReason}:{})
    });
  }
  return {
    schemaVersion:PDF_VISUAL_STRUCTURE_VERSION,authority:PDF_VISUAL_STRUCTURE_AUTHORITY,
    pageCount:rendered.pageCount,mixedPageCount:rendered.mixedPageCount,
    examinedPageCount:pages.length,pages,nativeTextUnchanged:true,
    productionRoutingChanged:false,goldApproved:false
  };
}
