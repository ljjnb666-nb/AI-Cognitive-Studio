import { sha256, validateEvidence, type SourceBlockInput } from "./chunking.js";

export type AnalysisStage = "CHUNK" | "SECTION" | "CHAPTER" | "BOOK";
export type EvidenceCandidate = { sourceBlockId: string; startOffset: number; endOffset: number; quoteText?: string };
export type MemoryCandidate = { type: "SUMMARY" | "CONCEPT" | "ARGUMENT" | "CLAIM" | "EXAMPLE" | "STORY" | "QUOTE" | "PERSON" | "QUESTION" | "COUNTERPOINT"; content: string; evidence?: EvidenceCandidate[] };
export type AnalysisResponse = { summary: string; memory?: MemoryCandidate[]; relations?: Array<{ fromOrdinal: number; toOrdinal: number; type: "EXPLAINS" | "SUPPORTS" | "OPPOSES" | "ASSOCIATED_WITH" | "DEVELOPS" }> };
export interface AnalysisRequest { stage: AnalysisStage; content: string; sourceBlockIds: string[]; tokenBudget: number; correlationId: string; systemInstructions: string; pipelineVersion?: string; promptVersion?: string; provider?: string; model?: string }
export interface AnalysisProvider { generateStructured(request: AnalysisRequest): Promise<AnalysisResponse> }
export class RecordingFakeAnalysisProvider implements AnalysisProvider { requests: AnalysisRequest[] = []; async generateStructured(request: AnalysisRequest): Promise<AnalysisResponse> { this.requests.push(structuredClone(request)); return { summary: request.content.slice(0, 240) }; } }

const memoryTypes = new Set(["SUMMARY", "CONCEPT", "ARGUMENT", "CLAIM", "EXAMPLE", "STORY", "QUOTE", "PERSON", "QUESTION", "COUNTERPOINT"]);
const relationTypes = new Set(["EXPLAINS", "SUPPORTS", "OPPOSES", "ASSOCIATED_WITH", "DEVELOPS"]);
export function validateAnalysisResponse(value: unknown): AnalysisResponse {
  if (!value || typeof value !== "object") throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); const response = value as AnalysisResponse;
  if (typeof response.summary !== "string" || !response.summary.trim() || response.summary.length > 20_000 || (response.memory !== undefined && !Array.isArray(response.memory)) || (response.relations !== undefined && !Array.isArray(response.relations))) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID");
  for (const item of response.memory ?? []) { if (!item || !memoryTypes.has(item.type) || typeof item.content !== "string" || !item.content.trim() || item.content.length > 20_000 || (item.evidence !== undefined && !Array.isArray(item.evidence))) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); for (const evidence of item.evidence ?? []) if (!evidence || typeof evidence.sourceBlockId !== "string" || !Number.isInteger(evidence.startOffset) || !Number.isInteger(evidence.endOffset) || (evidence.quoteText !== undefined && typeof evidence.quoteText !== "string")) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); }
  for (const relation of response.relations ?? []) if (!relation || !relationTypes.has(relation.type) || !Number.isInteger(relation.fromOrdinal) || !Number.isInteger(relation.toOrdinal)) throw new Error("ANALYSIS_PROVIDER_RESPONSE_INVALID"); return response;
}
export async function guardedGenerateStructured(provider: AnalysisProvider, request: AnalysisRequest, blocks: SourceBlockInput[], limit: number): Promise<AnalysisResponse> { assertBoundedProviderRequest(request, blocks, limit); return validateAnalysisResponse(await provider.generateStructured(request)); }

export function assertNoFullBookPrompt(requests: AnalysisRequest[], blocks: SourceBlockInput[], limit: number): void { for (const request of requests) assertBoundedProviderRequest(request, blocks, limit); }
export function assertBoundedProviderRequest(request: AnalysisRequest, blocks: SourceBlockInput[], limit: number): void {
  const whole = blocks.map((b) => b.text).join("\n\n"), ids = new Set(blocks.map((b) => b.id)), requested = new Set(request.sourceBlockIds);
  if (!request.systemInstructions || request.content === whole || request.content.length > limit || [...ids].every((id) => requested.has(id))) throw new Error("FULL_BOOK_PROMPT_PROHIBITED");
}
export function validateQuote(block: Pick<SourceBlockInput, "text">, evidence: EvidenceCandidate): string {
  if (!evidence.quoteText || !validateEvidence(block, evidence, evidence.quoteText)) throw new Error("INVALID_DIRECT_QUOTE");
  return sha256(evidence.quoteText);
}
