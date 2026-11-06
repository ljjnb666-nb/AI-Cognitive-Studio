import type { ExecutionSnapshot, GatewayRequest } from "@ai-cognitive/provider-gateway";

/** Runtime scheduling only: does not rewrite the frozen route or request identity. */
export function bookProviderExecutionPolicy(snapshot: ExecutionSnapshot, request: GatewayRequest) {
  if (snapshot.providerKey === "minimax" && snapshot.modelId === "MiniMax-M3" && request.capability.family === "TEXT_GENERATION" && ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"].includes(request.routeSlot)) return { timeoutMs: 120_000, maxAttempts: 1 };
  return undefined;
}
