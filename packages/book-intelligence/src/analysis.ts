import { sha256, validateEvidence, type SourceBlockInput } from "./chunking.js";

export type AnalysisStage = "CHUNK" | "SECTION" | "CHAPTER" | "BOOK";
export type EvidenceCandidate = { sourceBlockId: string; startOffset: number; endOffset: number; quoteText?: string };
export type MemoryCandidate = { type: "SUMMARY" | "CONCEPT" | "ARGUMENT" | "CLAIM" | "EXAMPLE" | "STORY" | "QUOTE" | "PERSON" | "QUESTION" | "COUNTERPOINT"; content: string; evidence?: EvidenceCandidate[] };
export type AnalysisResponse = { summary: string; memory?: MemoryCandidate[]; relations?: Array<{ fromOrdinal: number; toOrdinal: number; type: "EXPLAINS" | "SUPPORTS" | "OPPOSES" | "ASSOCIATED_WITH" | "DEVELOPS" }> };
export interface AnalysisRequest { stage: AnalysisStage; content: string; sourceBlockIds: string[]; tokenBudget: number; correlationId: string; systemInstructions: string; pipelineVersion?: string; promptVersion?: string; provider?: string; model?: string }
export interface AnalysisProvider { generateStructured(request: AnalysisRequest): Promise<AnalysisResponse> }
export class RecordingFakeAnalysisProvider implements AnalysisProvider { requests: AnalysisRequest[] = []; async generateStructured(request: AnalysisRequest): Promise<AnalysisResponse> { this.requests.push(structuredClone(request)); return { summary: request.content.slice(0, 240) }; } }
export function estimateAnalysisTokens(text: string): number { let cjkOrEmoji = 0, ascii = 0; for (const codePoint of text) { if (/^[\u3400-\u9FFF\uF900-\uFAFF\u{1F000}-\u{1FAFF}]$/u.test(codePoint)) cjkOrEmoji++; else ascii++; } return Math.max(cjkOrEmoji + Math.ceil(ascii / 3), Math.ceil([...text].length / 2)); }

const memoryTypes = new Set(["SUMMARY", "CONCEPT", "ARGUMENT", "CLAIM", "EXAMPLE", "STORY", "QUOTE", "PERSON", "QUESTION", "COUNTERPOINT"]);
const relationTypes = new Set(["EXPLAINS", "SUPPORTS", "OPPOSES", "ASSOCIATED_WITH", "DEVELOPS"]);
export function validateAnalysisResponse(value: unknown): AnalysisResponse {
  if (!value || typeof value !== "object") throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); const response = value as AnalysisResponse;
  if (typeof response.summary !== "string" || !response.summary.trim() || response.summary.length > 20_000 || (response.memory !== undefined && !Array.isArray(response.memory)) || (response.relations !== undefined && !Array.isArray(response.relations))) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID");
  for (const item of response.memory ?? []) { if (!item || !memoryTypes.has(item.type) || typeof item.content !== "string" || !item.content.trim() || item.content.length > 20_000 || (item.evidence !== undefined && !Array.isArray(item.evidence))) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); for (const evidence of item.evidence ?? []) if (!evidence || typeof evidence.sourceBlockId !== "string" || !Number.isInteger(evidence.startOffset) || !Number.isInteger(evidence.endOffset) || (evidence.quoteText !== undefined && typeof evidence.quoteText !== "string")) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); }
  for (const relation of response.relations ?? []) if (!relation || !relationTypes.has(relation.type) || !Number.isInteger(relation.fromOrdinal) || !Number.isInteger(relation.toOrdinal)) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); return response;
}
export async function guardedGenerateStructured(provider: AnalysisProvider, request: AnalysisRequest, blocks: SourceBlockInput[], limit: number): Promise<AnalysisResponse> { assertBoundedProviderRequest(request, blocks, limit); return validateAnalysisResponse(await provider.generateStructured(request)); }
export type ReductionBatchIdentity = { stage: AnalysisStage; parentKey: string; level: number; batchOrdinal: number; inputHash: string };
export type DurableReductionCache = { find(identity: ReductionBatchIdentity): Promise<AnalysisResponse | null>; persist(identity: ReductionBatchIdentity, response: AnalysisResponse): Promise<AnalysisResponse> };
export async function reduceBoundedAnalysisChildren(input: { provider: AnalysisProvider; stage: AnalysisStage; children: Array<{ ordinal: number; summary: string }>; blocks: SourceBlockInput[]; limit: number; correlationId: string; systemInstructions: string; pipelineVersion?: string; promptVersion?: string; parentKey?: string; cache?: DurableReductionCache; beforeGenerate?: (identity: ReductionBatchIdentity) => Promise<void> }): Promise<AnalysisResponse> {
  let level = [...input.children].sort((a, b) => a.ordinal - b.ordinal).map((child) => child.summary), depth = 0;
  if (!level.length) return { summary: "" };
  while (level.length > 1 || level[0]!.length > input.limit) {
    if (++depth > 12) throw new Error("ANALYSIS_REDUCTION_DID_NOT_CONVERGE");
    const batches: string[][] = []; let batch: string[] = [], size = 0;
    for (const summary of level) { if (summary.length > input.limit) { if (batch.length) { batches.push(batch); batch=[]; size=0; } for (let offset=0; offset<summary.length; offset += input.limit) batches.push([summary.slice(offset, offset + input.limit)]); continue; } const cost = (batch.length ? 1 : 0) + summary.length; if (batch.length && size + cost > input.limit) { batches.push(batch); batch=[]; size=0; } batch.push(summary); size += (batch.length === 1 ? 0 : 1) + summary.length; }
    if (batch.length) batches.push(batch); const next: string[] = [];
    for (const [batchOrdinal, group] of batches.entries()) { const content = group.join("\n"), identity = { stage: input.stage, parentKey: input.parentKey ?? input.stage, level: depth, batchOrdinal, inputHash: sha256(JSON.stringify(group)) }; const cached = input.cache ? await input.cache.find(identity) : null; if (!cached) await input.beforeGenerate?.(identity); const response = cached ?? await guardedGenerateStructured(input.provider, { stage: input.stage, content, sourceBlockIds: [], tokenBudget: estimateAnalysisTokens(content), correlationId: input.correlationId, systemInstructions: input.systemInstructions, pipelineVersion: input.pipelineVersion, promptVersion: input.promptVersion }, input.blocks, input.limit); const durable = cached ?? (input.cache ? await input.cache.persist(identity, response) : response); next.push(durable.summary); }
    if (next.length >= level.length && next.every((summary, index) => summary.length >= (level[index]?.length ?? 0))) throw new Error("ANALYSIS_REDUCTION_DID_NOT_CONVERGE"); level = next;
  }
  return { summary: level[0]! };
}

export function assertNoFullBookPrompt(requests: AnalysisRequest[], blocks: SourceBlockInput[], limit: number): void { for (const request of requests) assertBoundedProviderRequest(request, blocks, limit); }
export function assertBoundedProviderRequest(request: AnalysisRequest, blocks: SourceBlockInput[], limit: number): void {
  const whole = blocks.map((b) => b.text).join("\n\n"), ids = new Set(blocks.map((b) => b.id)), requested = new Set(request.sourceBlockIds);
  if (!request.systemInstructions || request.content === whole || request.content.length > limit || [...ids].every((id) => requested.has(id))) throw new Error("FULL_BOOK_PROMPT_PROHIBITED"); if (estimateAnalysisTokens(request.content) > request.tokenBudget) throw new Error("ANALYSIS_TOKEN_BUDGET_EXCEEDED");
}
export function validateQuote(block: Pick<SourceBlockInput, "text">, evidence: EvidenceCandidate): string {
  if (!evidence.quoteText || !validateEvidence(block, evidence, evidence.quoteText)) throw new Error("INVALID_DIRECT_QUOTE");
  return sha256(evidence.quoteText);
}
