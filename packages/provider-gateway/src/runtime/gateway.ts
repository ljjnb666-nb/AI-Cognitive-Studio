import { ProviderExecutionRepository } from "../execution-repository.js";
import { ProviderAdapterFailure, ProviderGatewayError } from "../errors.js";
import { ProviderRegistry } from "../registry.js";
import { resolveRoute, type WorkspaceRouteResolver } from "../routing/resolver.js";
import { createExecutionSnapshot } from "../routing/snapshot.js";
import { canonicalGatewayRequestFingerprint } from "../request-fingerprint.js";
import { validateTextGenerationInput } from "../text/validation.js";
import { embeddingDimensions, validateEmbeddingInput, validateVectors } from "../embedding/validation.js";
import { validateSpeechInput, validateSpeechResponse } from "../speech/validation.js";
import { resolvePlatformCredential, type PlatformCredentialResolver } from "./platform-credentials.js";
import type { ExecutionPrincipal, ExecutionSnapshot, GatewayRequest, PlatformDefaultResolver, ProviderAdapterResolver } from "../types.js";

export type GatewayExecutionDependencies = {
  authorize?: (principal: ExecutionPrincipal, request: GatewayRequest) => Promise<void>;
  assertRouteUsable?: (snapshot: ExecutionSnapshot) => Promise<void>;
  validateEndpoint?: (snapshot: ExecutionSnapshot) => Promise<void>;
  assertBudget?: (request: GatewayRequest) => void;
  beforeAttempt?: (snapshot: ExecutionSnapshot) => Promise<{ credential?: string }>;
  platformCredentials?: PlatformCredentialResolver;
  repository?: ProviderExecutionRepository;
  circuit?: { admit(key: string, cooldownMs: number): Promise<void>; recordSuccess(key: string): Promise<void>; recordRetryableFailure(key: string, threshold: number, cooldownMs: number): Promise<void> };
  rate?: { admit(key: string, limit: number, windowSeconds: number): Promise<void> };
  concurrency?: { acquire(key: string, limit: number, leaseMs: number): Promise<{ key: string; token: string }>; release(lease: { key: string; token: string }): Promise<boolean> };
  maxAttempts?: number; timeoutMs?: number; rateLimit?: number; rateWindowSeconds?: number; concurrencyLimit?: number; concurrencyLeaseMs?: number; circuitThreshold?: number; circuitCooldownMs?: number; sleep?: (milliseconds: number) => Promise<void>; random?: () => number;
};
export type GatewayExecutionResult = { status: "SUCCEEDED"; response?: unknown; usage?: unknown; remoteRequestId?: string; snapshot: ExecutionSnapshot; requestFingerprint: string; attempt: number; invocationId?: string } | { status: "ALREADY_PROCESSED"; invocationId: string; response?: unknown; snapshot?: ExecutionSnapshot; embeddingConsumed?: boolean; textConsumed?: boolean } | { status: "IN_PROGRESS" | "TERMINAL_FAILED" | "BLOCKED_EXISTING" | "RECONCILIATION_REQUIRED"; invocationId: string };

function assertInputHash(request: GatewayRequest): void { if (!/^[a-f0-9]{64}$/.test(request.inputHash)) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Invalid canonical input hash"); }
function assertBudget(request: GatewayRequest): void { const b = request.budget; const e = request.estimates; if (!b || !e) return; if ((b.maxInputTokens !== undefined && (e.inputTokens ?? 0) > b.maxInputTokens) || (b.maxOutputTokens !== undefined && (e.outputTokens ?? 0) > b.maxOutputTokens) || (b.maxEmbeddingInputTokens !== undefined && (e.embeddingInputTokens ?? 0) > b.maxEmbeddingInputTokens) || (b.maxSpeechCharacters !== undefined && (e.speechCharacters ?? 0) > b.maxSpeechCharacters)) throw new ProviderGatewayError("BUDGET_EXCEEDED"); }
function safeError(error: unknown, correlationId: string): ProviderGatewayError { const source = error instanceof ProviderGatewayError ? error : undefined; return new ProviderAdapterFailure(source?.code ?? "INTERNAL_PROVIDER_ERROR", { message: "Provider execution failed", retryable: source?.retryable, correlationId, remoteRequestId: source?.remoteRequestId, retryAfterMs: source?.retryAfterMs, usage: error instanceof ProviderAdapterFailure ? error.usage : undefined }); }
async function deadline<T>(work: (signal: AbortSignal) => Promise<T>, caller: AbortSignal | undefined, timeoutMs: number, onController?: (controller: AbortController) => void): Promise<T> { if (caller?.aborted) throw new ProviderGatewayError("CANCELLED"); const controller = new AbortController(); onController?.(controller); const onAbort = () => controller.abort(); caller?.addEventListener("abort", onAbort, { once: true }); let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs); try { return await work(controller.signal); } catch (error) { if (caller?.aborted) throw new ProviderGatewayError("CANCELLED"); if (timedOut) throw new ProviderGatewayError("TIMEOUT"); throw error; } finally { clearTimeout(timer); caller?.removeEventListener("abort", onAbort); } }

class ClaimHeartbeat {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  lost = false;
  constructor(private readonly intervalMs: number, private readonly renew: () => Promise<void>, private readonly abort: () => void) {}
  start(): void { this.timer = setTimeout(() => this.tick(), this.intervalMs); }
  private tick(): void {
    if (this.stopped || this.inFlight) return;
    this.inFlight = this.renew().catch(() => { this.lost = true; this.abort(); }).finally(() => {
      this.inFlight = undefined;
      if (!this.stopped && !this.lost) this.timer = setTimeout(() => this.tick(), this.intervalMs);
    });
  }
  async stopAndDrain(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }
}

class ProviderGatewayCore {
  constructor(private readonly registry: ProviderRegistry, private readonly workspaceRoutes: WorkspaceRouteResolver, private readonly platformDefaults: PlatformDefaultResolver, private readonly adapterResolver: ProviderAdapterResolver, private readonly execution: GatewayExecutionDependencies = {}) {}
  async resolveSnapshot(request: GatewayRequest): Promise<ExecutionSnapshot> { if (request.signal?.aborted) throw new ProviderGatewayError("CANCELLED"); const route = request.pinnedRoute ?? await resolveRoute(request, this.workspaceRoutes, this.platformDefaults); if (request.pinnedRoute && (!route.connectionId || !route.credentialVersionId || route.source !== "WORKSPACE")) throw new ProviderGatewayError("ROUTE_UNAVAILABLE", "Pinned Book route is incomplete"); const capability = this.registry.resolveCapability(route.providerKey, route.modelId, request.capability); return createExecutionSnapshot(request, { ...route, protocol: this.registry.resolveProtocol(route.providerKey, request.capability.family), capability }); }
  async execute(request: GatewayRequest, principal?: ExecutionPrincipal): Promise<GatewayExecutionResult> {
    if (!principal) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
    await this.execution.authorize?.(principal, request); if (request.signal?.aborted) throw new ProviderGatewayError("CANCELLED"); assertInputHash(request);
    this.validatePayload(request); let snapshot: ExecutionSnapshot;
    if (request.speech && this.execution.repository) { const existing = await this.execution.repository.findExistingSpeechInvocationForRequest(request); snapshot = existing ? await this.execution.repository.loadExecutionSnapshot(request.workspaceId, existing.snapshotId) : await this.resolveSnapshot(request); } else snapshot = await this.resolveSnapshot(request);
    assertBudget(request); this.execution.assertBudget?.(request); if (request.embedding) validateEmbeddingInput(request.embedding, snapshot.capability); if (request.speech) validateSpeechInput(request.speech, snapshot.capability, request.budget?.maxSpeechCharacters); await this.execution.validateEndpoint?.(snapshot); await this.execution.assertRouteUsable?.(snapshot);
    const fingerprint = canonicalGatewayRequestFingerprint(snapshot, request);
    const claim = this.execution.repository ? await this.execution.repository.claimExecution(snapshot, { idempotencyKey: request.idempotencyKey, fingerprint }) : { kind: "OWNER" as const, invocationId: undefined, claimToken: undefined, snapshotId: undefined };
    if (claim.kind !== "OWNER") {
      if (claim.kind === "ALREADY_PROCESSED" && (request.embedding || request.text || request.speech) && this.execution.repository) {
        const persistedSnapshot = await this.execution.repository.loadExecutionSnapshot(snapshot.workspaceId, claim.snapshotId);
        const handoff = request.embedding ? await this.execution.repository.recoverEmbeddingHandoff(snapshot.workspaceId, claim.invocationId) : request.speech ? await this.execution.repository.recoverSpeechHandoff(snapshot.workspaceId, claim.invocationId) : await this.execution.repository.recoverTextHandoff(snapshot.workspaceId, claim.invocationId);
        if (handoff.kind === "CONSUMED") return { status: "ALREADY_PROCESSED", invocationId: claim.invocationId, snapshot: persistedSnapshot, ...(request.embedding ? { embeddingConsumed: true } : { textConsumed: true }) };
        if (handoff.kind === "RECONCILIATION_REQUIRED") return { status: "RECONCILIATION_REQUIRED", invocationId: claim.invocationId };
        return { status: "ALREADY_PROCESSED", invocationId: claim.invocationId, response: handoff.response, snapshot: persistedSnapshot };
      }
      return { status: claim.kind, invocationId: claim.invocationId };
    }
    if (claim.snapshotId && this.execution.repository) snapshot = await this.execution.repository.loadExecutionSnapshot(snapshot.workspaceId, claim.snapshotId);
    const adapter = this.adapterResolver({ providerKey: snapshot.providerKey, family: request.capability.family, protocol: snapshot.protocol, modelId: snapshot.modelId });
    if (!adapter) {
      if (claim.invocationId && claim.claimToken && this.execution.repository) {
        try { await this.execution.repository.releasePreRemoteClaim(snapshot.workspaceId, claim.invocationId, claim.claimToken); }
        catch (error) { throw safeError(error, request.correlationId); }
      }
      throw new ProviderGatewayError("ROUTE_UNAVAILABLE", "No installed adapter for pinned provider");
    }
    if (request.embedding && this.execution.repository) {
      try { this.execution.repository.assertEmbeddingResultStorageAvailable(); }
      catch (error) {
        try { await this.execution.repository.releasePreRemoteClaim(snapshot.workspaceId, claim.invocationId!, claim.claimToken!); }
        catch (releaseError) { throw safeError(releaseError, request.correlationId); }
        throw error;
      }
    }
    if (request.text && this.execution.repository) {
      try { this.execution.repository.assertTextResultStorageAvailable(); }
      catch (error) { try { await this.execution.repository.releasePreRemoteClaim(snapshot.workspaceId, claim.invocationId!, claim.claimToken!); } catch (releaseError) { throw safeError(releaseError, request.correlationId); } throw error; }
    }
    if (request.speech && this.execution.repository) { try { this.execution.repository.assertSpeechResultStorageAvailable(); } catch (error) { try { await this.execution.repository.releasePreRemoteClaim(snapshot.workspaceId, claim.invocationId!, claim.claimToken!); } catch (releaseError) { throw safeError(releaseError, request.correlationId); } throw error; } }
    const key = `${snapshot.workspaceId}:${snapshot.connectionId ?? snapshot.providerKey}:${snapshot.modelId}`; const maxAttempts = Math.min(request.budget?.maxAttempts ?? this.execution.maxAttempts ?? 3, this.execution.maxAttempts ?? 3); let last: ProviderGatewayError | undefined;
    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
      if (request.signal?.aborted) { await this.finish(claim, snapshot, "BLOCKED"); throw new ProviderGatewayError("CANCELLED"); }
      let remoteStarted = false;
      try {
        if (claim.invocationId && claim.claimToken) { await this.execution.repository!.renewClaim(snapshot.workspaceId, claim.invocationId, claim.claimToken); await this.execution.repository!.assertExecutionOwnership(snapshot.workspaceId, claim.invocationId, claim.claimToken); }
        const state = snapshot.connectionId ? this.execution.repository ? await this.execution.repository.loadPinnedRuntimeState(snapshot.workspaceId, snapshot.id) : await this.execution.beforeAttempt?.(snapshot) : snapshot.source === "PLATFORM" ? snapshot.protocol === "TEST" ? {} : this.execution.repository ? { credential: await resolvePlatformCredential(this.execution.platformCredentials, snapshot) } : await this.execution.beforeAttempt?.(snapshot) : await this.execution.beforeAttempt?.(snapshot);
        await this.execution.circuit?.admit(key, this.execution.circuitCooldownMs ?? 1_000);
        await this.execution.rate?.admit(key, this.execution.rateLimit ?? 60, this.execution.rateWindowSeconds ?? 60);
        const lease = await this.execution.concurrency?.acquire(key, this.execution.concurrencyLimit ?? 4, this.execution.concurrencyLeaseMs ?? 30_000);
        const startedAt = Date.now(); const durableAttempt = claim.invocationId && claim.claimToken ? await this.execution.repository!.startAttempt(snapshot.workspaceId, claim.invocationId, claim.claimToken) : undefined; remoteStarted = Boolean(durableAttempt);
        let remoteSucceeded = false; let heartbeatLost = false;
        try {
          let heartbeat: ClaimHeartbeat | undefined; let result;
          try { result = await deadline(signal => adapter.execute({ snapshot, request: { ...request, requestFingerprint: fingerprint }, signal, credential: state?.credential }), request.signal, this.execution.timeoutMs ?? 30_000, controller => { if (!claim.invocationId || !claim.claimToken || !this.execution.repository) return; heartbeat = new ClaimHeartbeat(Math.max(1, Math.floor(this.execution.repository.leaseDurationMs / 3)), () => this.execution.repository!.renewClaim(snapshot.workspaceId, claim.invocationId!, claim.claimToken!), () => controller.abort()); heartbeat.start(); }); } finally { await heartbeat?.stopAndDrain(); heartbeatLost = heartbeat?.lost ?? false; }
          if (heartbeatLost) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership heartbeat was lost");
          remoteSucceeded = true;
          const latencyMs = Date.now() - startedAt;
          try {
            if (durableAttempt) {
              if (request.embedding) {
                const response = result.response;
                if (!response || typeof response !== "object" || !("vectors" in response) || !("dimensions" in response)) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE");
                const embeddingResponse = response as import("../types.js").EmbeddingResponse, pinnedDimensions = embeddingDimensions(snapshot.capability, snapshot.configuration);
                if (embeddingResponse.dimensions !== pinnedDimensions) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE");
                validateVectors(embeddingResponse.vectors, request.embedding.texts.length, pinnedDimensions);
                await this.execution.repository!.completeSuccessfulEmbeddingExecution({ workspaceId: snapshot.workspaceId, invocationId: claim.invocationId!, claimToken: claim.claimToken!, attempt: durableAttempt, snapshot, response: embeddingResponse, expectedVectorCount: request.embedding.texts.length, pinnedDimensions, usage: result.usage, remoteRequestId: result.remoteRequestId, latencyMs, exactSecret: state?.credential });
              } else if (request.text) {
                const response = result.response;
                await this.execution.repository!.completeSuccessfulTextExecution({ workspaceId: snapshot.workspaceId, invocationId: claim.invocationId!, claimToken: claim.claimToken!, attempt: durableAttempt, snapshot, response: response as import("../types.js").TextGenerationResponse, usage: result.usage, remoteRequestId: result.remoteRequestId, latencyMs, exactSecret: state?.credential });
              } else if (request.speech) {
                const response = result.response as import("../types.js").SpeechResponse; validateSpeechResponse(response, request.speech.outputFormat);
                await this.execution.repository!.completeSuccessfulSpeechExecution({ workspaceId: snapshot.workspaceId, invocationId: claim.invocationId!, claimToken: claim.claimToken!, attempt: durableAttempt, snapshot, response, usage: result.usage, spokenText: request.speech!.text, remoteRequestId: result.remoteRequestId, latencyMs, exactSecret: state?.credential });
              } else { await this.execution.repository!.recordAttemptOutcome(snapshot.workspaceId, claim.invocationId!, claim.claimToken!, durableAttempt.id, "SUCCEEDED", { remoteRequestId: result.remoteRequestId, latencyMs }, { snapshot, attempt: durableAttempt, status: "SUCCEEDED", usage: result.usage, exactSecret: state?.credential }); await this.execution.repository!.completeInvocation(snapshot.workspaceId, claim.invocationId!, claim.claimToken!, "SUCCEEDED");
              }
            }
          } catch (persistenceError) { if (claim.invocationId && claim.claimToken) await this.execution.repository!.completeInvocation(snapshot.workspaceId, claim.invocationId, claim.claimToken, "RECONCILIATION_REQUIRED").catch(() => undefined); throw safeError(persistenceError, request.correlationId); }
          await this.execution.circuit?.recordSuccess(key);
          return { status: "SUCCEEDED", ...result, snapshot, requestFingerprint: fingerprint, attempt: attemptNumber, invocationId: claim.invocationId };
        } catch (error) {
          if (remoteSucceeded) throw error;
          if (heartbeatLost) { if (durableAttempt) await this.execution.repository!.completeAttempt(snapshot.workspaceId, claim.invocationId!, claim.claimToken!, durableAttempt.id, "REMOTE_OUTCOME_UNKNOWN", { failureCode: "REMOTE_OUTCOME_UNKNOWN", latencyMs: Date.now() - startedAt }).catch(() => undefined); if (claim.invocationId && claim.claimToken) await this.execution.repository!.completeInvocation(snapshot.workspaceId, claim.invocationId, claim.claimToken, "RECONCILIATION_REQUIRED").catch(() => undefined); throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership was lost during remote execution", { correlationId: request.correlationId }); }
          const normalized = safeError(error, request.correlationId); const latencyMs = Date.now() - startedAt;
          if (durableAttempt) { const status = normalized.code === "TIMEOUT" ? "TIMEOUT" : normalized.code === "CANCELLED" ? "CANCELLED_AFTER_REQUEST" : "REMOTE_FAILURE"; try { await this.execution.repository!.recordAttemptOutcome(snapshot.workspaceId, claim.invocationId!, claim.claimToken!, durableAttempt.id, status, { failureCode: normalized.code, remoteRequestId: normalized.remoteRequestId, latencyMs }, normalized instanceof ProviderAdapterFailure ? { snapshot, attempt: durableAttempt, status: "FAILED", usage: normalized.usage, exactSecret: state?.credential } : undefined); } catch (accountingError) { await this.execution.repository!.completeInvocation(snapshot.workspaceId, claim.invocationId!, claim.claimToken!, "RECONCILIATION_REQUIRED").catch(() => undefined); throw safeError(accountingError, request.correlationId); } }
          if (normalized.code === "CANCELLED") { await this.finish(claim, snapshot, "BLOCKED"); throw normalized; }
          last = normalized; if (normalized.retryable) await this.execution.circuit?.recordRetryableFailure(key, this.execution.circuitThreshold ?? 3, this.execution.circuitCooldownMs ?? 1_000); if (!normalized.retryable || attemptNumber === maxAttempts) { await this.finish(claim, snapshot, "FAILED"); throw normalized; }
          const delay = Math.round(100 * 2 ** (attemptNumber - 1) * (0.5 + (this.execution.random?.() ?? 0.5))); if (claim.invocationId && claim.claimToken) await this.execution.repository!.renewClaim(snapshot.workspaceId, claim.invocationId, claim.claimToken); await (this.execution.sleep?.(delay) ?? new Promise<void>(resolve => setTimeout(resolve, delay)));
        } finally { if (lease) await this.execution.concurrency?.release(lease); }
      } catch (error) { const normalized = safeError(error, request.correlationId); if (!remoteStarted && (normalized.code === "CIRCUIT_OPEN" || normalized.code === "RATE_LIMITED")) await this.execution.repository?.releasePreRemoteClaim(snapshot.workspaceId, claim.invocationId!, claim.claimToken!).catch(() => undefined); else if (normalized.code === "CONNECTION_DISABLED" || normalized.code === "CREDENTIAL_REVOKED") await this.finish(claim, snapshot, "BLOCKED"); throw normalized; }
    }
    await this.finish(claim, snapshot, "FAILED"); throw last ?? new ProviderGatewayError("INTERNAL_PROVIDER_ERROR");
  }
  private validatePayload(request: GatewayRequest): void { if (request.capability.family === "TEXT_GENERATION") { if (request.embedding || request.speech) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Invalid runtime payload family"); if (request.text) validateTextGenerationInput(request.text); return; } if (request.capability.family === "EMBEDDING") { if (request.text || request.speech) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Invalid runtime payload family"); return; } if (!request.speech || request.text || request.embedding) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Invalid runtime payload family"); }
  private async finish(claim: { kind: "OWNER"; invocationId?: string; claimToken?: string }, snapshot: ExecutionSnapshot, status: "FAILED" | "BLOCKED") { if (claim.invocationId && claim.claimToken) await this.execution.repository!.completeInvocation(snapshot.workspaceId, claim.invocationId, claim.claimToken, status).catch(() => undefined); }
}

export type ProviderGateway = { resolveSnapshot(request: GatewayRequest): Promise<ExecutionSnapshot>; execute(request: GatewayRequest, principal?: ExecutionPrincipal): Promise<GatewayExecutionResult> };
export function createTestProviderGateway(registry: ProviderRegistry, workspaceRoutes: WorkspaceRouteResolver, platformDefaults: PlatformDefaultResolver, adapterResolver: ProviderAdapterResolver, execution: GatewayExecutionDependencies = {}): ProviderGateway { return new ProviderGatewayCore(registry, workspaceRoutes, platformDefaults, adapterResolver, execution); }
export function createProductionProviderGateway(registry: ProviderRegistry, workspaceRoutes: WorkspaceRouteResolver, platformDefaults: PlatformDefaultResolver, adapterResolver: ProviderAdapterResolver, execution: GatewayExecutionDependencies): ProviderGateway { const required: (keyof GatewayExecutionDependencies)[] = ["authorize", "assertRouteUsable", "validateEndpoint", "assertBudget", "repository", "circuit", "rate", "concurrency"]; for (const key of required) if (!execution[key]) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", `Missing mandatory production gateway dependency: ${key}`); return new ProviderGatewayCore(registry, workspaceRoutes, platformDefaults, adapterResolver, execution); }
