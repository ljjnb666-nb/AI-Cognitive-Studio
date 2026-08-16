import { ProviderExecutionRepository } from "../execution-repository.js";
import { ProviderAdapterFailure, ProviderGatewayError } from "../errors.js";
import { ProviderRegistry } from "../registry.js";
import { resolveRoute, type WorkspaceRouteResolver } from "../routing/resolver.js";
import { createExecutionSnapshot, stableHash } from "../routing/snapshot.js";
import type { ExecutionPrincipal, ExecutionSnapshot, GatewayRequest, PlatformDefaultResolver, ProviderAdapter } from "../types.js";

export type GatewayExecutionDependencies = {
  authorize?: (principal: ExecutionPrincipal, request: GatewayRequest) => Promise<void>;
  assertRouteUsable?: (snapshot: ExecutionSnapshot) => Promise<void>;
  validateEndpoint?: (snapshot: ExecutionSnapshot) => Promise<void>;
  assertBudget?: (request: GatewayRequest) => void;
  beforeAttempt?: (snapshot: ExecutionSnapshot) => Promise<{ credential?: string }>;
  repository?: ProviderExecutionRepository;
  circuit?: { admit(key: string, cooldownMs: number): Promise<void>; recordSuccess(key: string): Promise<void>; recordRetryableFailure(key: string, threshold: number, cooldownMs: number): Promise<void> };
  rate?: { admit(key: string, limit: number, windowSeconds: number): Promise<void> };
  concurrency?: { acquire(key: string, limit: number, leaseMs: number): Promise<{ key: string; token: string }>; release(lease: { key: string; token: string }): Promise<boolean> };
  maxAttempts?: number; timeoutMs?: number; rateLimit?: number; rateWindowSeconds?: number; concurrencyLimit?: number; concurrencyLeaseMs?: number; circuitThreshold?: number; circuitCooldownMs?: number; sleep?: (milliseconds: number) => Promise<void>; random?: () => number;
};
export type GatewayExecutionResult = { status: "SUCCEEDED"; response?: unknown; usage?: unknown; remoteRequestId?: string; snapshot: ExecutionSnapshot; requestFingerprint: string; attempt: number; invocationId?: string } | { status: "ALREADY_PROCESSED" | "IN_PROGRESS" | "TERMINAL_FAILED" | "BLOCKED_EXISTING" | "RECONCILIATION_REQUIRED"; invocationId: string };

function assertInputHash(request: GatewayRequest): void { if (!/^[a-f0-9]{64}$/.test(request.inputHash)) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Invalid canonical input hash"); }
function assertBudget(request: GatewayRequest): void { const b = request.budget; const e = request.estimates; if (!b || !e) return; if ((b.maxInputTokens !== undefined && (e.inputTokens ?? 0) > b.maxInputTokens) || (b.maxOutputTokens !== undefined && (e.outputTokens ?? 0) > b.maxOutputTokens) || (b.maxEmbeddingInputTokens !== undefined && (e.embeddingInputTokens ?? 0) > b.maxEmbeddingInputTokens) || (b.maxSpeechCharacters !== undefined && (e.speechCharacters ?? 0) > b.maxSpeechCharacters)) throw new ProviderGatewayError("BUDGET_EXCEEDED"); }
function safeError(error: unknown, correlationId: string): ProviderGatewayError { const source = error instanceof ProviderGatewayError ? error : undefined; return new ProviderAdapterFailure(source?.code ?? "INTERNAL_PROVIDER_ERROR", { message: "Provider execution failed", retryable: source?.retryable, correlationId, remoteRequestId: source?.remoteRequestId, retryAfterMs: source?.retryAfterMs, usage: error instanceof ProviderAdapterFailure ? error.usage : undefined }); }
async function deadline<T>(work: (signal: AbortSignal) => Promise<T>, caller: AbortSignal | undefined, timeoutMs: number): Promise<T> { if (caller?.aborted) throw new ProviderGatewayError("CANCELLED"); const controller = new AbortController(); const onAbort = () => controller.abort(); caller?.addEventListener("abort", onAbort, { once: true }); let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); try { return await work(controller.signal); } catch (error) { if (caller?.aborted) throw new ProviderGatewayError("CANCELLED"); if (timedOut) throw new ProviderGatewayError("TIMEOUT"); throw error; } finally { clearTimeout(timer); caller?.removeEventListener("abort", onAbort); } }

class ProviderGatewayCore {
  constructor(private readonly registry: ProviderRegistry, private readonly workspaceRoutes: WorkspaceRouteResolver, private readonly platformDefaults: PlatformDefaultResolver, private readonly adapterResolver: (providerKey: string) => ProviderAdapter | undefined, private readonly execution: GatewayExecutionDependencies = {}) {}
  async resolveSnapshot(request: GatewayRequest): Promise<ExecutionSnapshot> { if (request.signal?.aborted) throw new ProviderGatewayError("CANCELLED"); const route = await resolveRoute(request, this.workspaceRoutes, this.platformDefaults); const capability = this.registry.resolveCapability(route.providerKey, route.modelId, request.capability); return createExecutionSnapshot(request, { ...route, capability }); }
  async execute(request: GatewayRequest, principal?: ExecutionPrincipal): Promise<GatewayExecutionResult> {
    if (!principal) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
    await this.execution.authorize?.(principal, request); if (request.signal?.aborted) throw new ProviderGatewayError("CANCELLED"); assertInputHash(request);
    const snapshot = await this.resolveSnapshot(request); assertBudget(request); this.execution.assertBudget?.(request); await this.execution.validateEndpoint?.(snapshot); await this.execution.assertRouteUsable?.(snapshot);
    const adapter = this.adapterResolver(snapshot.providerKey); if (!adapter) throw new ProviderGatewayError("ROUTE_UNAVAILABLE", "No installed adapter for resolved provider");
    const fingerprint = stableHash({ routeSlot: snapshot.routeSlot, providerKey: snapshot.providerKey, protocol: snapshot.protocol, modelId: snapshot.modelId, connectionId: snapshot.connectionId, credentialVersionId: snapshot.credentialVersionId, configuration: snapshot.configuration, capability: request.capability, promptVersion: request.promptVersion, schemaVersion: request.schemaVersion, pipelineVersion: request.pipelineVersion, inputHash: request.inputHash });
    const claim = this.execution.repository ? await this.execution.repository.claimExecution(snapshot, { idempotencyKey: request.idempotencyKey, fingerprint }) : { kind: "OWNER" as const, invocationId: undefined, claimToken: undefined };
    if (claim.kind !== "OWNER") return { status: claim.kind, invocationId: claim.invocationId };
    const key = `${snapshot.workspaceId}:${snapshot.connectionId ?? snapshot.providerKey}:${snapshot.modelId}`; const maxAttempts = Math.min(request.budget?.maxAttempts ?? this.execution.maxAttempts ?? 3, this.execution.maxAttempts ?? 3); let last: ProviderGatewayError | undefined;
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
      if (request.signal?.aborted) { await this.finish(claim, snapshot, "BLOCKED"); throw new ProviderGatewayError("CANCELLED"); }
      let remoteStarted = false;
      try {
        if (claim.invocationId && claim.claimToken) { await this.execution.repository!.renewClaim(snapshot.workspaceId, claim.invocationId, claim.claimToken); await this.execution.repository!.assertExecutionOwnership(snapshot.workspaceId, claim.invocationId, claim.claimToken); }
        const state = this.execution.repository ? await this.execution.repository.loadPinnedRuntimeState(snapshot.workspaceId, snapshot.id) : await this.execution.beforeAttempt?.(snapshot);
        await this.execution.circuit?.admit(key, this.execution.circuitCooldownMs ?? 1_000);
        await this.execution.rate?.admit(key, this.execution.rateLimit ?? 60, this.execution.rateWindowSeconds ?? 60);
        const lease = await this.execution.concurrency?.acquire(key, this.execution.concurrencyLimit ?? 4, this.execution.concurrencyLeaseMs ?? 30_000);
        const startedAt = Date.now(); const durableAttempt = claim.invocationId && claim.claimToken ? await this.execution.repository!.startAttempt(snapshot.workspaceId, claim.invocationId, claim.claimToken) : undefined; remoteStarted = Boolean(durableAttempt);
        let remoteSucceeded = false;
        try {
          const result = await deadline(signal => adapter.execute({ snapshot, request: { ...request, requestFingerprint: fingerprint }, signal, credential: state?.credential }), request.signal, this.execution.timeoutMs ?? 30_000);
          remoteSucceeded = true;
          const latencyMs = Date.now() - startedAt;
          try {
            if (durableAttempt) { await this.execution.repository!.completeAttempt(snapshot.workspaceId, claim.invocationId!, claim.claimToken!, durableAttempt.id, "SUCCEEDED", { remoteRequestId: result.remoteRequestId, latencyMs }); await this.execution.repository!.appendUsage({ workspaceId: snapshot.workspaceId, invocationId: claim.invocationId!, attempt: durableAttempt, snapshot, status: "SUCCEEDED", usage: result.usage, remoteRequestId: result.remoteRequestId, latencyMs }); await this.execution.repository!.completeInvocation(snapshot.workspaceId, claim.invocationId!, claim.claimToken!, "SUCCEEDED"); }
          } catch (persistenceError) { if (claim.invocationId && claim.claimToken) await this.execution.repository!.completeInvocation(snapshot.workspaceId, claim.invocationId, claim.claimToken, "RECONCILIATION_REQUIRED").catch(() => undefined); throw safeError(persistenceError, request.correlationId); }
          await this.execution.circuit?.recordSuccess(key);
          return { status: "SUCCEEDED", ...result, snapshot, requestFingerprint: fingerprint, attempt: attemptNumber, invocationId: claim.invocationId };
        } catch (error) {
          if (remoteSucceeded) throw error;
          const normalized = safeError(error, request.correlationId); const latencyMs = Date.now() - startedAt;
          if (durableAttempt) { const status = normalized.code === "TIMEOUT" ? "TIMEOUT" : normalized.code === "CANCELLED" ? "CANCELLED_AFTER_REQUEST" : "REMOTE_FAILURE"; await this.execution.repository!.completeAttempt(snapshot.workspaceId, claim.invocationId!, claim.claimToken!, durableAttempt.id, status, { failureCode: normalized.code, remoteRequestId: normalized.remoteRequestId, latencyMs }).catch(() => undefined); if (normalized instanceof ProviderAdapterFailure) await this.execution.repository!.appendUsage({ workspaceId: snapshot.workspaceId, invocationId: claim.invocationId!, attempt: durableAttempt, snapshot, status: "FAILED", usage: normalized.usage, remoteRequestId: normalized.remoteRequestId, latencyMs }); }
          if (normalized.code === "CANCELLED") { await this.finish(claim, snapshot, "BLOCKED"); throw normalized; }
          last = normalized; if (normalized.retryable) await this.execution.circuit?.recordRetryableFailure(key, this.execution.circuitThreshold ?? 3, this.execution.circuitCooldownMs ?? 1_000); if (!normalized.retryable || attemptNumber === maxAttempts) { await this.finish(claim, snapshot, "FAILED"); throw normalized; }
          const delay = Math.round(100 * 2 ** (attemptNumber - 1) * (0.5 + (this.execution.random?.() ?? 0.5))); if (claim.invocationId && claim.claimToken) await this.execution.repository!.renewClaim(snapshot.workspaceId, claim.invocationId, claim.claimToken); await (this.execution.sleep?.(delay) ?? new Promise<void>(resolve => setTimeout(resolve, delay)));
        } finally { if (lease) await this.execution.concurrency?.release(lease); }
      } catch (error) { const normalized = safeError(error, request.correlationId); if (!remoteStarted && (normalized.code === "CIRCUIT_OPEN" || normalized.code === "RATE_LIMITED")) await this.execution.repository?.releasePreRemoteClaim(snapshot.workspaceId, claim.invocationId!, claim.claimToken!).catch(() => undefined); else if (normalized.code === "CONNECTION_DISABLED" || normalized.code === "CREDENTIAL_REVOKED") await this.finish(claim, snapshot, "BLOCKED"); throw normalized; }
    }
    await this.finish(claim, snapshot, "FAILED"); throw last ?? new ProviderGatewayError("INTERNAL_PROVIDER_ERROR");
  }
  private async finish(claim: { kind: "OWNER"; invocationId?: string; claimToken?: string }, snapshot: ExecutionSnapshot, status: "FAILED" | "BLOCKED") { if (claim.invocationId && claim.claimToken) await this.execution.repository!.completeInvocation(snapshot.workspaceId, claim.invocationId, claim.claimToken, status).catch(() => undefined); }
}

export type ProviderGateway = { resolveSnapshot(request: GatewayRequest): Promise<ExecutionSnapshot>; execute(request: GatewayRequest, principal?: ExecutionPrincipal): Promise<GatewayExecutionResult> };
export function createTestProviderGateway(registry: ProviderRegistry, workspaceRoutes: WorkspaceRouteResolver, platformDefaults: PlatformDefaultResolver, adapterResolver: (providerKey: string) => ProviderAdapter | undefined, execution: GatewayExecutionDependencies = {}): ProviderGateway { return new ProviderGatewayCore(registry, workspaceRoutes, platformDefaults, adapterResolver, execution); }
export function createProductionProviderGateway(registry: ProviderRegistry, workspaceRoutes: WorkspaceRouteResolver, platformDefaults: PlatformDefaultResolver, adapterResolver: (providerKey: string) => ProviderAdapter | undefined, execution: GatewayExecutionDependencies): ProviderGateway { const required: (keyof GatewayExecutionDependencies)[] = ["authorize", "assertRouteUsable", "validateEndpoint", "assertBudget", "repository", "circuit", "rate", "concurrency"]; for (const key of required) if (!execution[key]) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", `Missing mandatory production gateway dependency: ${key}`); return new ProviderGatewayCore(registry, workspaceRoutes, platformDefaults, adapterResolver, execution); }
