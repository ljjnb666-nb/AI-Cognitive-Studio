import type { ExecutionSnapshot, GatewayRequest } from "@ai-cognitive/provider-gateway";

/** 思考和答案共用输出额度；按阶段统一管理输出、等待和租约。 */
const minimaxBookLimits = Object.freeze({ maxOutputTokens: 32_000, timeoutMs: 600_000, leaseMs: 630_000 });
const minimaxSynthesisLimits = Object.freeze({ maxOutputTokens: 128_000, timeoutMs: 900_000, leaseMs: 930_000 });
const limitsForStage = (stage?: string) => stage === "BOOK" ? minimaxSynthesisLimits : minimaxBookLimits;
export function bookProviderGeneration(snapshot: Pick<ExecutionSnapshot, "providerKey" | "modelId">, stage?: string) {
  return snapshot.providerKey === "minimax" && snapshot.modelId === "MiniMax-M3" ? { maxOutputTokens: limitsForStage(stage).maxOutputTokens } : undefined;
}

/** 仅控制新请求的调度，不改写冻结路由、历史身份或回执。 */
export function bookProviderExecutionPolicy(snapshot: ExecutionSnapshot, request: GatewayRequest) {
  if (snapshot.providerKey === "minimax" && snapshot.modelId === "MiniMax-M3" && request.capability.family === "TEXT_GENERATION" && ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"].includes(request.routeSlot)) return { timeoutMs: limitsForStage(request.routeSlot === "BOOK_SYNTHESIS" ? "BOOK" : undefined).timeoutMs, maxAttempts: 1 };
  return undefined;
}

export function bookProviderLeaseMs(stage?: string): number { return limitsForStage(stage).leaseMs; }
