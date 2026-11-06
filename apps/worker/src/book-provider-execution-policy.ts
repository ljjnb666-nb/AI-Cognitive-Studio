import type { ExecutionSnapshot, GatewayRequest } from "@ai-cognitive/provider-gateway";

export function bookProviderGeneration(snapshot: Pick<ExecutionSnapshot, "providerKey" | "modelId">, stage?: string) {
  return snapshot.providerKey === "minimax" && snapshot.modelId === "MiniMax-M3" ? { maxOutputTokens: stage === "CHUNK" ? 32_000 : 16_000 } : undefined;
}

/** Runtime scheduling only: does not rewrite the frozen route or request identity. */
export function bookProviderExecutionPolicy(snapshot: ExecutionSnapshot, request: GatewayRequest) {
  if (snapshot.providerKey === "minimax" && snapshot.modelId === "MiniMax-M3" && request.capability.family === "TEXT_GENERATION" && ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"].includes(request.routeSlot)) return { timeoutMs: request.routeSlot === "BOOK_CHUNK_ANALYSIS" ? 600_000 : 300_000, maxAttempts: 1 };
  return undefined;
}

/** 思考和答案共用输出额度，较长的分块请求必须同步延长所有权保护。 */
export function bookProviderLeaseMs(stage: string): number { return stage === "CHUNK" ? 630_000 : 330_000; }
