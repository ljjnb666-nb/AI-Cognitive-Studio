import { sha256, type SourceBlockInput } from "./chunking.js";

export type AnalysisStage = "CHUNK" | "SECTION" | "CHAPTER" | "BOOK";
export type EvidenceCandidate = { sourceBlockId: string; startOffset: number; endOffset: number; quoteText?: string };
export type MemoryCandidate = { type: "SUMMARY" | "CONCEPT" | "ARGUMENT" | "CLAIM" | "EXAMPLE" | "STORY" | "QUOTE" | "PERSON" | "QUESTION" | "COUNTERPOINT"; content: string; evidence?: EvidenceCandidate[] };
export type AnalysisResponse = { summary: string; memory?: MemoryCandidate[]; relations?: Array<{ fromOrdinal: number; toOrdinal: number; type: "EXPLAINS" | "SUPPORTS" | "OPPOSES" | "ASSOCIATED_WITH" | "DEVELOPS" }> };
export interface AnalysisRequest { stage: AnalysisStage; content: string; sourceBlockIds: string[]; tokenBudget: number; correlationId: string; systemInstructions: string; pipelineVersion?: string; promptVersion?: string; provider?: string; model?: string }
export interface AnalysisProvider { generateStructured(request: AnalysisRequest): Promise<AnalysisResponse> }
export class RecordingFakeAnalysisProvider implements AnalysisProvider { requests: AnalysisRequest[] = []; async generateStructured(request: AnalysisRequest): Promise<AnalysisResponse> { this.requests.push(structuredClone(request)); return { summary: request.content.slice(0, 240) }; } }

export function assertNoFullBookPrompt(requests: AnalysisRequest[], blocks: SourceBlockInput[], limit: number): void { for (const request of requests) assertBoundedProviderRequest(request, blocks, limit); }
export function assertBoundedProviderRequest(request: AnalysisRequest, blocks: SourceBlockInput[], limit: number): void {
  const whole = blocks.map((b) => b.text).join("\n\n"), ids = new Set(blocks.map((b) => b.id)), requested = new Set(request.sourceBlockIds);
  if (!request.systemInstructions || request.content === whole || request.content.length > limit || [...ids].every((id) => requested.has(id))) throw new Error("FULL_BOOK_PROMPT_PROHIBITED");
}
export function validateQuote(block: Pick<SourceBlockInput, "text">, evidence: EvidenceCandidate): string {
  if (!evidence.quoteText || evidence.startOffset < 0 || evidence.endOffset <= evidence.startOffset || evidence.endOffset > block.text.length || block.text.slice(evidence.startOffset, evidence.endOffset) !== evidence.quoteText) throw new Error("INVALID_DIRECT_QUOTE");
  return sha256(evidence.quoteText.toLowerCase());
}
