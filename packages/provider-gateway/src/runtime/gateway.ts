import { ProviderGatewayError } from "../errors.js";
import { ProviderRegistry } from "../registry.js";
import { resolveRoute, type WorkspaceRouteResolver } from "../routing/resolver.js";
import { createExecutionSnapshot, stableHash } from "../routing/snapshot.js";
import type { ExecutionSnapshot, GatewayRequest, PlatformDefaultResolver, ProviderAdapter, TrustedExecutionContext } from "../types.js";

export type GatewayExecutionDependencies = {
  authorize?: (context: TrustedExecutionContext, request: GatewayRequest) => Promise<void>;
  assertRouteUsable?: (snapshot: ExecutionSnapshot) => Promise<{ credential?: string }>;
  validateEndpoint?: (snapshot: ExecutionSnapshot) => Promise<void>;
  assertBudget?: (request: GatewayRequest) => void;
  reserveIdempotency?: (input: { workspaceId: string; idempotencyKey: string; fingerprint: string }) => Promise<"OWNER" | "ALREADY_PROCESSED" | "IN_PROGRESS">;
  beforeAttempt?: (snapshot: ExecutionSnapshot) => Promise<{ credential?: string }>;
  circuit?: { admit(key: string, cooldownMs: number): Promise<void>; recordSuccess(key: string): Promise<void>; recordRetryableFailure(key: string, threshold: number, cooldownMs: number): Promise<void> };
  rate?: { admit(key: string, limit: number, windowSeconds: number): Promise<void> };
  concurrency?: { acquire(key: string, limit: number, leaseMs: number): Promise<{ key: string; token: string }>; release(lease: { key: string; token: string }): Promise<boolean> };
  maxAttempts?: number; timeoutMs?: number; rateLimit?: number; rateWindowSeconds?: number; concurrencyLimit?: number; concurrencyLeaseMs?: number; circuitThreshold?: number; circuitCooldownMs?: number; sleep?: (milliseconds: number) => Promise<void>; random?: () => number;
};

function assertBudget(request: GatewayRequest): void { const b = request.budget; const e = request.estimates; if (!b || !e) return; if ((b.maxInputTokens !== undefined && (e.inputTokens ?? 0) > b.maxInputTokens) || (b.maxOutputTokens !== undefined && (e.outputTokens ?? 0) > b.maxOutputTokens) || (b.maxEmbeddingInputTokens !== undefined && (e.embeddingInputTokens ?? 0) > b.maxEmbeddingInputTokens) || (b.maxSpeechCharacters !== undefined && (e.speechCharacters ?? 0) > b.maxSpeechCharacters)) throw new ProviderGatewayError("BUDGET_EXCEEDED"); }
function safeError(error: unknown, secrets: readonly string[]): ProviderGatewayError { if (error instanceof ProviderGatewayError) return error; const raw = error instanceof Error ? error.message : String(error); const redacted = secrets.reduce((value, secret) => secret ? value.split(secret).join("[REDACTED]") : value, raw); return new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", redacted.includes("[REDACTED]") ? "Provider execution failed" : "Provider execution failed"); }
async function deadline<T>(work: (signal: AbortSignal) => Promise<T>, caller: AbortSignal | undefined, timeoutMs: number): Promise<T> { if (caller?.aborted) throw new ProviderGatewayError("CANCELLED"); const controller = new AbortController(); const onAbort = () => controller.abort(); caller?.addEventListener("abort", onAbort, { once: true }); let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); try { return await work(controller.signal); } catch (error) { if (caller?.aborted) throw new ProviderGatewayError("CANCELLED"); if (timedOut) throw new ProviderGatewayError("TIMEOUT"); throw error; } finally { clearTimeout(timer); caller?.removeEventListener("abort", onAbort); } }

export class ProviderGateway {
  constructor(private readonly registry: ProviderRegistry, private readonly workspaceRoutes: WorkspaceRouteResolver, private readonly platformDefaults: PlatformDefaultResolver, private readonly adapterResolver: (providerKey: string) => ProviderAdapter | undefined, private readonly execution: GatewayExecutionDependencies = {}) {}
  async resolveSnapshot(request: GatewayRequest) { if (request.signal?.aborted) throw new ProviderGatewayError("CANCELLED"); const route = await resolveRoute(request, this.workspaceRoutes, this.platformDefaults); const capability = this.registry.resolveCapability(route.providerKey, route.modelId, request.capability); return createExecutionSnapshot(request, { ...route, capability }); }
  async execute(request: GatewayRequest, context?: TrustedExecutionContext) {
    if (!context || context.trusted !== true || context.workspaceId !== request.workspaceId) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
    await this.execution.authorize?.(context, request); if (request.signal?.aborted) throw new ProviderGatewayError("CANCELLED");
    const snapshot = await this.resolveSnapshot(request); assertBudget(request); this.execution.assertBudget?.(request); await this.execution.validateEndpoint?.(snapshot);
    const fingerprint = stableHash({ routeSlot: snapshot.routeSlot, providerKey: snapshot.providerKey, protocol: snapshot.protocol, modelId: snapshot.modelId, connectionId: snapshot.connectionId, credentialVersionId: snapshot.credentialVersionId, configuration: snapshot.configuration, capability: request.capability, promptVersion: request.promptVersion, schemaVersion: request.schemaVersion, pipelineVersion: request.pipelineVersion, inputHash: request.inputHash });
    const reservation = await this.execution.reserveIdempotency?.({ workspaceId: request.workspaceId, idempotencyKey: request.idempotencyKey, fingerprint });
    if (reservation === "ALREADY_PROCESSED" || reservation === "IN_PROGRESS") throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT", reservation);
    const adapter = this.adapterResolver(snapshot.providerKey); if (!adapter) throw new ProviderGatewayError("ROUTE_UNAVAILABLE", "No installed adapter for resolved provider");
    const key = `${snapshot.workspaceId}:${snapshot.connectionId ?? snapshot.providerKey}:${snapshot.modelId}`; const maxAttempts = Math.min(request.budget?.maxAttempts ?? this.execution.maxAttempts ?? 3, this.execution.maxAttempts ?? 3); let lease: { key: string; token: string } | undefined;
    try { await this.execution.assertRouteUsable?.(snapshot); await this.execution.circuit?.admit(key, this.execution.circuitCooldownMs ?? 1_000); await this.execution.rate?.admit(key, this.execution.rateLimit ?? 60, this.execution.rateWindowSeconds ?? 60); lease = await this.execution.concurrency?.acquire(key, this.execution.concurrencyLimit ?? 4, this.execution.concurrencyLeaseMs ?? 30_000); let last: ProviderGatewayError | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) { if (request.signal?.aborted) throw new ProviderGatewayError("CANCELLED"); const state = await this.execution.beforeAttempt?.(snapshot); try { const result = await deadline(signal => adapter.execute({ snapshot, request: { ...request, requestFingerprint: fingerprint }, signal, credential: state?.credential }), request.signal, this.execution.timeoutMs ?? 30_000); await this.execution.circuit?.recordSuccess(key); return { ...result, snapshot, requestFingerprint: fingerprint, attempt }; } catch (error) { const normalized = safeError(error, state?.credential ? [state.credential] : []); last = normalized; if (normalized.retryable) await this.execution.circuit?.recordRetryableFailure(key, this.execution.circuitThreshold ?? 3, this.execution.circuitCooldownMs ?? 1_000); if (!normalized.retryable || attempt === maxAttempts) throw normalized; const delay = Math.round(100 * 2 ** (attempt - 1) * (0.5 + (this.execution.random?.() ?? 0.5))); await (this.execution.sleep?.(delay) ?? new Promise<void>(resolve => setTimeout(resolve, delay))); } }
      throw last ?? new ProviderGatewayError("INTERNAL_PROVIDER_ERROR");
    } finally { if (lease) await this.execution.concurrency?.release(lease); }
  }
}

export function createProductionProviderGateway(registry: ProviderRegistry, workspaceRoutes: WorkspaceRouteResolver, platformDefaults: PlatformDefaultResolver, adapterResolver: (providerKey: string) => ProviderAdapter | undefined, execution: GatewayExecutionDependencies): ProviderGateway {
  const required: (keyof GatewayExecutionDependencies)[] = ["authorize", "assertRouteUsable", "validateEndpoint", "assertBudget", "reserveIdempotency", "beforeAttempt", "circuit", "rate", "concurrency"];
  for (const key of required) if (!execution[key]) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", `Missing mandatory production gateway dependency: ${key}`);
  return new ProviderGateway(registry, workspaceRoutes, platformDefaults, adapterResolver, execution);
}
