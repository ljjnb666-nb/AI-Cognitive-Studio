import { sha256, validateEvidence, type SourceBlockInput } from "./chunking.js";

export type AnalysisStage = "CHUNK" | "SECTION" | "CHAPTER" | "BOOK";
export type EvidenceCandidate = { sourceBlockId: string; startOffset: number; endOffset: number; quoteText?: string };
export type MemoryCandidate = { type: "SUMMARY" | "CONCEPT" | "ARGUMENT" | "CLAIM" | "EXAMPLE" | "STORY" | "QUOTE" | "PERSON" | "QUESTION" | "COUNTERPOINT"; content: string; evidence?: EvidenceCandidate[] };
export type AnalysisResponse = { summary: string; memory?: MemoryCandidate[]; relations?: Array<{ fromOrdinal: number; toOrdinal: number; type: "EXPLAINS" | "SUPPORTS" | "OPPOSES" | "ASSOCIATED_WITH" | "DEVELOPS" }> };
export type BoundedChunkProvenance = { chunkId: string; contentHash: string; sourceBlockIds: string[] };
export interface AnalysisRequest { stage: AnalysisStage; content: string; sourceBlockIds: string[]; sourceEvidence?: Array<{ sourceBlockId: string; startOffset: number; endOffset: number; text: string }>; tokenBudget: number; correlationId: string; systemInstructions: string; pipelineVersion?: string; promptVersion?: string; provider?: string; model?: string; operationKey?: string; boundedChunk?: BoundedChunkProvenance }
export interface AnalysisProvider { generateStructured(request: AnalysisRequest): Promise<AnalysisResponse> }
export type AnalysisTransaction = { $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> };
export type AnalysisReceiptConsumer = { consumerKind: string; consumerKey: string; consumerFingerprint: string; materialize: (tx: AnalysisTransaction, response: AnalysisResponse) => Promise<void> };
export interface DurableAnalysisProvider extends AnalysisProvider { consumeGenerated?(response: AnalysisResponse, consumer: AnalysisReceiptConsumer): Promise<"CONSUMED" | "ALREADY_CONSUMED"> }
export class RecordingFakeAnalysisProvider implements AnalysisProvider { requests: AnalysisRequest[] = []; async generateStructured(request: AnalysisRequest): Promise<AnalysisResponse> { this.requests.push(structuredClone(request)); return { summary: request.content.slice(0, 240) }; } }
export function estimateAnalysisTokens(text: string): number { let cjkOrEmoji = 0, ascii = 0; for (const codePoint of text) { if (/^[\u3400-\u9FFF\uF900-\uFAFF\u{1F000}-\u{1FAFF}]$/u.test(codePoint)) cjkOrEmoji++; else ascii++; } return Math.max(cjkOrEmoji + Math.ceil(ascii / 3), Math.ceil([...text].length / 2)); }

const memoryTypes = new Set(["SUMMARY", "CONCEPT", "ARGUMENT", "CLAIM", "EXAMPLE", "STORY", "QUOTE", "PERSON", "QUESTION", "COUNTERPOINT"]);
const relationTypes = new Set(["EXPLAINS", "SUPPORTS", "OPPOSES", "ASSOCIATED_WITH", "DEVELOPS"]);
export const bookAnalysisRelationsContractVersion = "book-relations-zero-based-v1";
export const bookAnalysisRelationsInstruction = "Relations contract: fromOrdinal and toOrdinal are zero-based indices into the memory array in THIS response only, never source, chunk or input-memory ordinals. For N memory items, both indices must be integers from 0 through N-1. For 6 items the valid indices are 0,1,2,3,4,5; index 6 is invalid. If memory is absent or empty, omit relations or return []. Do not invent a relation when its endpoints are uncertain.";
/** Validate newly generated responses without rewriting historical artifacts. */
export function assertAnalysisRelationsWithinMemory(response: Pick<AnalysisResponse, "memory" | "relations">): void {
  const count = response.memory?.length ?? 0;
  for (const relation of response.relations ?? []) {
    if (!relation || !Number.isSafeInteger(relation.fromOrdinal) || !Number.isSafeInteger(relation.toOrdinal) || relation.fromOrdinal < 0 || relation.toOrdinal < 0 || relation.fromOrdinal >= count || relation.toOrdinal >= count) throw new Error("ANALYSIS_RELATION_INVALID");
  }
}
/** Read complete citation objects, including objects inside a bounded JSON fragment.
 * JSON key order and braces inside quoted strings carry no citation semantics. */
export function extractDerivedEvidenceRanges(content: string): EvidenceCandidate[] {
  const ranges: EvidenceCandidate[] = [];
  for (const match of content.matchAll(/\{(?:[^{}"\\]|"(?:\\.|[^"\\])*")*\}/g)) {
    try {
      const value = JSON.parse(match[0]) as Partial<EvidenceCandidate>;
      if (typeof value.sourceBlockId === "string" && value.sourceBlockId && Number.isSafeInteger(value.startOffset) && Number.isSafeInteger(value.endOffset) && value.startOffset! >= 0 && value.endOffset! > value.startOffset!) ranges.push({ sourceBlockId: value.sourceBlockId, startOffset: value.startOffset!, endOffset: value.endOffset! });
    } catch { /* Incomplete fragments cannot grant an evidence range. */ }
  }
  return ranges;
}
export function validateAnalysisResponse(value: unknown): AnalysisResponse {
  if (!value || typeof value !== "object") throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); const response = value as AnalysisResponse;
  if (typeof response.summary !== "string" || !response.summary.trim() || response.summary.length > 20_000 || (response.memory !== undefined && !Array.isArray(response.memory)) || (response.relations !== undefined && !Array.isArray(response.relations))) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID");
  for (const item of response.memory ?? []) { if (!item || !memoryTypes.has(item.type) || typeof item.content !== "string" || !item.content.trim() || item.content.length > 20_000 || (item.evidence !== undefined && !Array.isArray(item.evidence))) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); for (const evidence of item.evidence ?? []) if (!evidence || typeof evidence.sourceBlockId !== "string" || !Number.isInteger(evidence.startOffset) || !Number.isInteger(evidence.endOffset) || (evidence.quoteText !== undefined && typeof evidence.quoteText !== "string")) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); }
  for (const relation of response.relations ?? []) if (!relation || !relationTypes.has(relation.type) || !Number.isInteger(relation.fromOrdinal) || !Number.isInteger(relation.toOrdinal)) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); return response;
}
/** Reject a valid block ID when its returned range was not supplied in this chunk. */
export function assertAnalysisEvidenceWithinRequest(response: AnalysisResponse, request: Pick<AnalysisRequest, "stage" | "sourceEvidence">): void {
  if (request.stage !== "CHUNK" || !request.sourceEvidence) return;
  for (const item of response.memory ?? []) for (const evidence of item.evidence ?? []) {
    if (!request.sourceEvidence.some(span => span.sourceBlockId === evidence.sourceBlockId && Number.isSafeInteger(evidence.startOffset) && Number.isSafeInteger(evidence.endOffset) && evidence.startOffset >= span.startOffset && evidence.endOffset <= span.endOffset && evidence.endOffset > evidence.startOffset)) throw new Error("CHUNK_EVIDENCE_INVALID");
  }
}
export async function guardedGenerateStructured(provider: AnalysisProvider, request: AnalysisRequest, blocks: SourceBlockInput[], limit: number): Promise<AnalysisResponse> {
  assertBoundedProviderRequest(request, blocks, limit);
  const response = validateAnalysisResponse(await provider.generateStructured(request));
  assertAnalysisRelationsWithinMemory(response);
  assertAnalysisEvidenceWithinRequest(response, request);
  return response;
}
export type ReductionBatchIdentity = { stage: AnalysisStage; parentKey: string; level: number; batchOrdinal: number; inputHash: string };
export type DurableReductionCache = { find(identity: ReductionBatchIdentity): Promise<AnalysisResponse | null>; persist(identity: ReductionBatchIdentity, response: AnalysisResponse): Promise<AnalysisResponse> };
/** Derived intelligence only: retain factual memory and its source locators, never raw book text. */
export function derivedAnalysisText(response: AnalysisResponse): string {
  return response.memory?.length || response.relations?.length ? JSON.stringify(response) : response.summary;
}
export async function reduceBoundedAnalysisChildren(input: { provider: AnalysisProvider; stage: AnalysisStage; children: Array<{ ordinal: number; summary: string; analysis?: AnalysisResponse }>; blocks: SourceBlockInput[]; limit: number; higherLevelLimit?: number; correlationId: string; systemInstructions: string; pipelineVersion?: string; promptVersion?: string; parentKey?: string; cache?: DurableReductionCache; beforeGenerate?: (identity: ReductionBatchIdentity) => Promise<void> }): Promise<AnalysisResponse> {
  const ordered=[...input.children].sort((a,b)=>a.ordinal-b.ordinal);
  let level=ordered.map(child=>child.analysis?derivedAnalysisText(child.analysis):child.summary),depth=0,finalResponse:AnalysisResponse|undefined=ordered.length===1?ordered[0]!.analysis:undefined;
  if (!level.length) return { summary: "" };
  while (level.length > 1 || level[0]!.length > input.limit) {
    if (++depth > 12) throw new Error("ANALYSIS_REDUCTION_DID_NOT_CONVERGE");
    const levelLimit = depth > 1 ? input.higherLevelLimit ?? input.limit : input.limit;
    const batches: string[][] = []; let batch: string[] = [], size = 0;
    for (const summary of level) { if (summary.length > levelLimit) { if (batch.length) { batches.push(batch); batch=[]; size=0; } for (let offset=0; offset<summary.length; offset += levelLimit) batches.push([summary.slice(offset, offset + levelLimit)]); continue; } const cost = (batch.length ? 1 : 0) + summary.length; if (batch.length && size + cost > levelLimit) { batches.push(batch); batch=[]; size=0; } batch.push(summary); size += (batch.length === 1 ? 0 : 1) + summary.length; }
    if (batch.length) batches.push(batch); const next: string[] = []; const nextResponses: AnalysisResponse[]=[];
    for (const [batchOrdinal, group] of batches.entries()) { const content = group.join("\n"), identity = { stage: input.stage, parentKey: input.parentKey ?? input.stage, level: depth, batchOrdinal, inputHash: sha256(JSON.stringify(group)) }; const cached = input.cache ? await input.cache.find(identity) : null; if (!cached) await input.beforeGenerate?.(identity); const response = cached ?? await guardedGenerateStructured(input.provider, { stage: input.stage, content, sourceBlockIds: [], tokenBudget: estimateAnalysisTokens(content), correlationId: input.correlationId, systemInstructions: input.systemInstructions, pipelineVersion: input.pipelineVersion, promptVersion: input.promptVersion, operationKey: sha256(JSON.stringify(identity)) }, input.blocks, levelLimit); const durable = cached ?? (input.cache ? await input.cache.persist(identity, response) : response); next.push(derivedAnalysisText(durable));nextResponses.push(durable); }
    if (next.length >= level.length && next.every((summary, index) => summary.length >= (level[index]?.length ?? 0))) throw new Error("ANALYSIS_REDUCTION_DID_NOT_CONVERGE"); level = next;
    finalResponse = nextResponses.length === 1 ? nextResponses[0] : undefined;
  }
  return finalResponse ?? { summary: level[0]! };
}

export function assertNoFullBookPrompt(requests: AnalysisRequest[], blocks: SourceBlockInput[], limit: number): void { for (const request of requests) assertBoundedProviderRequest(request, blocks, limit); }
export function assertBoundedProviderRequest(request: AnalysisRequest, blocks: SourceBlockInput[], limit: number): void {
  const whole = blocks.map((b) => b.text).join("\n\n"), ids = new Set(blocks.map((b) => b.id)), requested = new Set(request.sourceBlockIds), provenance = request.boundedChunk, provenanceIds = new Set(provenance?.sourceBlockIds ?? []);
  const sameIds = requested.size === provenanceIds.size && [...requested].every((id) => provenanceIds.has(id));
  const isBoundedChunk = request.stage === "CHUNK" && Boolean(provenance?.chunkId) && provenance?.contentHash === sha256(request.content) && sameIds && [...requested].every((id) => ids.has(id));
  const containsWholeSource = request.content === whole || [...ids].every((id) => requested.has(id));
  if (request.sourceEvidence && (request.stage !== "CHUNK" || request.sourceEvidence.map(span => span.text).join("\n\n") !== request.content || request.sourceEvidence.some(span => {
    const block = blocks.find(block => block.id === span.sourceBlockId);
    return !block || !requested.has(span.sourceBlockId) || !Number.isSafeInteger(span.startOffset) || !Number.isSafeInteger(span.endOffset) || span.startOffset < 0 || span.endOffset <= span.startOffset || span.endOffset > block.text.length || block.text.slice(span.startOffset, span.endOffset) !== span.text;
  }))) throw new Error("INVALID_CHUNK_EVIDENCE_PAYLOAD");
  if (!request.systemInstructions || request.content.length > limit || (containsWholeSource && !isBoundedChunk)) throw new Error("FULL_BOOK_PROMPT_PROHIBITED"); if (estimateAnalysisTokens(request.content) > request.tokenBudget) throw new Error("ANALYSIS_TOKEN_BUDGET_EXCEEDED");
}
export function validateQuote(block: Pick<SourceBlockInput, "text">, evidence: EvidenceCandidate): string {
  if (!evidence.quoteText || !validateEvidence(block, evidence, evidence.quoteText)) throw new Error("INVALID_DIRECT_QUOTE");
  return sha256(evidence.quoteText);
}
