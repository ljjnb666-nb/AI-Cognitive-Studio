import type { ExecutionSnapshot, GatewayRequest } from "@ai-cognitive/provider-gateway";

/** 思考和答案共用输出额度；所有书籍文本阶段必须使用同一套保护值。 */
const minimaxBookLimits = Object.freeze({ maxOutputTokens: 32_000, timeoutMs: 600_000, leaseMs: 630_000 });
export function bookProviderGeneration(snapshot: Pick<ExecutionSnapshot, "providerKey" | "modelId">) {
  return snapshot.providerKey === "minimax" && snapshot.modelId === "MiniMax-M3" ? { maxOutputTokens: minimaxBookLimits.maxOutputTokens } : undefined;
}

/** 仅控制新请求的调度，不改写冻结路由、历史身份或回执。 */
export function bookProviderExecutionPolicy(snapshot: ExecutionSnapshot, request: GatewayRequest) {
  if (snapshot.providerKey === "minimax" && snapshot.modelId === "MiniMax-M3" && request.capability.family === "TEXT_GENERATION" && ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"].includes(request.routeSlot)) return { timeoutMs: minimaxBookLimits.timeoutMs, maxAttempts: 1 };
  return undefined;
}

export function bookProviderLeaseMs(): number { return minimaxBookLimits.leaseMs; }
