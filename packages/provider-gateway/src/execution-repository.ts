import { prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { VersionedAesGcmCipher, type CredentialCipher, type EmbeddingResultCipher } from "./credentials/cipher.js";
import { redactSecrets } from "./credentials/redaction.js";
import { embeddingDimensions, validateVectors } from "./embedding/validation.js";
import { ProviderGatewayError } from "./errors.js";
import type { EmbeddingResponse, ExecutionSnapshot, ModelCapability, ProviderUsage } from "./types.js";

type Db = typeof prisma;
export type ExecutionClaim = { kind: "OWNER"; invocationId: string; claimToken: string; snapshotId: string } | { kind: "ALREADY_PROCESSED"; invocationId: string } | { kind: "IN_PROGRESS"; invocationId: string } | { kind: "TERMINAL_FAILED"; invocationId: string } | { kind: "BLOCKED_EXISTING"; invocationId: string } | { kind: "RECONCILIATION_REQUIRED"; invocationId: string };
export type StartedAttempt = { id: string; attemptNumber: number };
const leaseMilliseconds = 60_000;
const bounded = (value: string | undefined) => value && value.length <= 256 ? value : undefined;
const uniqueViolation = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";

export class ProviderExecutionRepository {
  constructor(private readonly db: Db = prisma, private readonly cipher?: CredentialCipher & Partial<EmbeddingResultCipher>, private readonly testClock?: () => Date, private readonly workerId = `gateway-${randomUUID()}`, private readonly leaseMs = leaseMilliseconds) {}
  private async databaseNow(): Promise<Date> { if (this.testClock) return this.testClock(); const rows = await this.db.$queryRaw<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP AS "now"`; return rows[0]?.now ?? (() => { throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Database clock unavailable"); })(); }
  get leaseDurationMs(): number { return this.leaseMs; }
  assertEmbeddingResultStorageAvailable(): void { if (!this.cipher?.encryptEmbeddingResult || !this.cipher.decryptEmbeddingResult) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Embedding result vault is not configured"); }

  async claimExecution(snapshot: ExecutionSnapshot, input: { idempotencyKey: string; fingerprint: string }): Promise<ExecutionClaim> {
    const claimToken = randomUUID(); const now = await this.databaseNow(); const expiresAt = new Date(now.getTime() + this.leaseMs);
    try {
      const invocation = await this.db.$transaction(async tx => {
        await tx.providerExecutionSnapshot.create({ data: snapshotData(snapshot) });
        return tx.providerInvocation.create({ data: { id: randomUUID(), workspaceId: snapshot.workspaceId, snapshotId: snapshot.id, connectionId: snapshot.connectionId, credentialVersionId: snapshot.credentialVersionId, providerKey: snapshot.providerKey, protocol: snapshot.protocol, modelId: snapshot.modelId, routeSlot: snapshot.routeSlot, idempotencyKey: input.idempotencyKey, requestFingerprint: input.fingerprint, correlationId: snapshot.correlationId, status: "RUNNING", claimToken, claimOwner: this.workerId, claimExpiresAt: expiresAt } });
      });
      return { kind: "OWNER", invocationId: invocation.id, claimToken, snapshotId: invocation.snapshotId };
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
    }
    const existing = await this.db.providerInvocation.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: snapshot.workspaceId, idempotencyKey: input.idempotencyKey }, }, include: { attempts: { select: { id: true, status: true } }, embeddingResult: { select: { id: true } } } });
    if (!existing) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR");
    if (existing.requestFingerprint !== input.fingerprint) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT");
    if (existing.status === "SUCCEEDED") return snapshot.capability.families.includes("EMBEDDING") && !existing.embeddingResult ? { kind: "RECONCILIATION_REQUIRED", invocationId: existing.id } : { kind: "ALREADY_PROCESSED", invocationId: existing.id };
    if (existing.status === "FAILED") return { kind: "TERMINAL_FAILED", invocationId: existing.id };
    if (existing.status === "BLOCKED") return { kind: "BLOCKED_EXISTING", invocationId: existing.id };
    if (existing.status === "RECONCILIATION_REQUIRED") return { kind: "RECONCILIATION_REQUIRED", invocationId: existing.id };
    if (existing.status === "RUNNING" && existing.claimExpiresAt && existing.claimExpiresAt > now) return { kind: "IN_PROGRESS", invocationId: existing.id };
    if (existing.attempts.some(attempt => attempt.status === "RUNNING" || attempt.status === "REMOTE_OUTCOME_UNKNOWN")) { const recovery = await this.markStaleAttemptUnknown(snapshot.workspaceId, existing.id); return recovery.kind === "ACTIVE_OWNER" ? { kind: "IN_PROGRESS", invocationId: existing.id } : { kind: "RECONCILIATION_REQUIRED", invocationId: existing.id }; }
    if (existing.attempts.some(attempt => attempt.status === "SUCCEEDED")) return { kind: "RECONCILIATION_REQUIRED", invocationId: existing.id };
    if (existing.attempts.length > 0) return { kind: existing.attempts.every(attempt => attempt.status === "REMOTE_FAILURE") ? "TERMINAL_FAILED" : "RECONCILIATION_REQUIRED", invocationId: existing.id };
    if (existing.attempts.length === 0 && (existing.status === "PENDING" || (existing.claimExpiresAt && existing.claimExpiresAt <= now))) {
      if (this.testClock) {
        const reclaimed = await this.db.providerInvocation.updateMany({ where: { id: existing.id, workspaceId: snapshot.workspaceId, claimToken: existing.claimToken ?? undefined, status: existing.status, OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lte: now } }] }, data: { status: "RUNNING", claimToken, claimOwner: this.workerId, claimExpiresAt: expiresAt, completedAt: null } });
        if (reclaimed.count === 1) return { kind: "OWNER", invocationId: existing.id, claimToken, snapshotId: existing.snapshotId };
      } else {
        const reclaimed = await this.db.providerInvocation.updateMany({ where: { id: existing.id, workspaceId: snapshot.workspaceId, status: existing.status, attempts: { none: {} }, OR: [{ status: "PENDING" }, { status: "RUNNING", claimExpiresAt: { lte: now } }] }, data: { status: "RUNNING", claimToken, claimOwner: this.workerId, claimExpiresAt: expiresAt, completedAt: null } });
        if (reclaimed.count === 1) return { kind: "OWNER", invocationId: existing.id, claimToken, snapshotId: existing.snapshotId };
      }
    }
    return { kind: "IN_PROGRESS", invocationId: existing.id };
  }

  async assertExecutionOwnership(workspaceId: string, invocationId: string, claimToken: string): Promise<void> {
    const now = await this.databaseNow(); const owned = await this.db.providerInvocation.findFirst({ where: { id: invocationId, workspaceId, claimToken, status: "RUNNING", claimExpiresAt: { gt: now } }, select: { id: true } });
    if (!owned) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership was lost");
  }

  async renewClaim(workspaceId: string, invocationId: string, claimToken: string): Promise<void> {
    if (this.testClock) {
      const now = this.testClock();
      const updated = await this.db.providerInvocation.updateMany({ where: { id: invocationId, workspaceId, claimToken, status: "RUNNING", claimExpiresAt: { gt: now } }, data: { claimExpiresAt: new Date(now.getTime() + this.leaseMs) } });
      if (updated.count !== 1) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership was lost");
      return;
    }
    const updated = await this.db.$executeRaw`UPDATE "ProviderInvocation" SET "claimExpiresAt" = CURRENT_TIMESTAMP + (${this.leaseMs} * INTERVAL '1 millisecond') WHERE "id" = ${invocationId} AND "workspaceId" = ${workspaceId} AND "claimToken" = ${claimToken} AND "status" = 'RUNNING' AND "claimExpiresAt" > CURRENT_TIMESTAMP`;
    if (updated !== 1) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership was lost");
  }
  async releasePreRemoteClaim(workspaceId: string, invocationId: string, claimToken: string): Promise<void> { const updated = await this.db.providerInvocation.updateMany({ where: { id: invocationId, workspaceId, claimToken, status: "RUNNING", attempts: { none: {} } }, data: { status: "PENDING", claimToken: null, claimOwner: null, claimExpiresAt: null } }); if (updated.count !== 1) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership was lost"); }
  async markStaleAttemptUnknown(workspaceId: string, invocationId: string): Promise<{ kind: "RECOVERED_TO_RECONCILIATION" | "ACTIVE_OWNER" | "NOT_APPLICABLE" }> { return this.db.$transaction(async tx => { const rows = await tx.$queryRaw<{ status: string; claimExpiresAt: Date | null }[]>`SELECT "status", "claimExpiresAt" FROM "ProviderInvocation" WHERE "id" = ${invocationId} AND "workspaceId" = ${workspaceId} FOR UPDATE`; const current = rows[0]; const clockRows = await tx.$queryRaw<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP AS "now"`; const now = this.testClock ? this.testClock() : clockRows[0]?.now; if (!current || !now || current.status !== "RUNNING") return { kind: "NOT_APPLICABLE" }; if (!current.claimExpiresAt || current.claimExpiresAt > now) return { kind: "ACTIVE_OWNER" }; await tx.providerInvocationAttempt.updateMany({ where: { workspaceId, invocationId, status: "RUNNING" }, data: { status: "REMOTE_OUTCOME_UNKNOWN", completedAt: now, failureCode: "REMOTE_OUTCOME_UNKNOWN" } }); await tx.providerInvocation.update({ where: { id_workspaceId: { id: invocationId, workspaceId } }, data: { status: "RECONCILIATION_REQUIRED", claimToken: null, claimOwner: null, claimExpiresAt: null, completedAt: now } }); return { kind: "RECOVERED_TO_RECONCILIATION" }; }); }
  async startAttempt(workspaceId: string, invocationId: string, claimToken: string): Promise<StartedAttempt> {
    return this.db.$transaction(async tx => {
      await this.assertOwnershipInTransaction(tx, workspaceId, invocationId, claimToken);
      const latest = await tx.providerInvocationAttempt.aggregate({ where: { invocationId, workspaceId }, _max: { attemptNumber: true } });
      return tx.providerInvocationAttempt.create({ data: { id: randomUUID(), workspaceId, invocationId, attemptNumber: (latest._max.attemptNumber ?? 0) + 1, status: "RUNNING" }, select: { id: true, attemptNumber: true } });
    });
  }

  async loadPinnedRuntimeState(workspaceId: string, snapshotId: string): Promise<{ credential?: string }> {
    const snapshot = await this.db.providerExecutionSnapshot.findUnique({ where: { id_workspaceId: { id: snapshotId, workspaceId } }, include: { connection: true, credentialVersion: true } });
    if (!snapshot) throw new ProviderGatewayError("ROUTE_UNAVAILABLE");
    if (!snapshot.connectionId) return {};
    if (!snapshot.connection || snapshot.connection.status !== "ACTIVE") throw new ProviderGatewayError("CONNECTION_DISABLED");
    const credential = snapshot.credentialVersion;
    if (!credential || credential.connectionId !== snapshot.connectionId || credential.workspaceId !== workspaceId) throw new ProviderGatewayError("AUTHENTICATION_FAILED");
    if (credential.status === "REVOKED") throw new ProviderGatewayError("CREDENTIAL_REVOKED");
    if (!this.cipher) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Credential vault is not configured");
    return { credential: this.cipher.decrypt(credential, { workspaceId, connectionId: snapshot.connectionId, credentialVersionId: credential.id, providerKey: snapshot.providerKey }) };
  }

  async completeAttempt(workspaceId: string, invocationId: string, claimToken: string, attemptId: string, status: "SUCCEEDED" | "REMOTE_FAILURE" | "TIMEOUT" | "CANCELLED_AFTER_REQUEST" | "REMOTE_OUTCOME_UNKNOWN", input: { failureCode?: string; remoteRequestId?: string; latencyMs: number }): Promise<void> {
    await this.recordAttemptOutcome(workspaceId, invocationId, claimToken, attemptId, status, input);
  }

  async recordAttemptOutcome(workspaceId: string, invocationId: string, claimToken: string, attemptId: string, status: "SUCCEEDED" | "REMOTE_FAILURE" | "TIMEOUT" | "CANCELLED_AFTER_REQUEST" | "REMOTE_OUTCOME_UNKNOWN", input: { failureCode?: string; remoteRequestId?: string; latencyMs: number }, usage?: { snapshot: ExecutionSnapshot; attempt: StartedAttempt; status: "SUCCEEDED" | "FAILED"; usage?: ProviderUsage; exactSecret?: string }): Promise<void> {
    await this.db.$transaction(async tx => {
      await this.assertOwnershipInTransaction(tx, workspaceId, invocationId, claimToken);
      const now = await this.databaseNow();
      const updated = await tx.providerInvocationAttempt.updateMany({ where: { id: attemptId, invocationId, workspaceId, status: "RUNNING" }, data: { status, failureCode: bounded(input.failureCode), remoteRequestId: bounded(input.remoteRequestId), latencyMs: Math.max(0, Math.min(Math.round(input.latencyMs), 86_400_000)), completedAt: now } });
      if (updated.count !== 1) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Attempt finalization was not owned");
      if (usage?.usage) await this.appendUsageWithClient(tx, { workspaceId, invocationId, attempt: usage.attempt, snapshot: usage.snapshot, status: usage.status, usage: usage.usage, remoteRequestId: input.remoteRequestId, latencyMs: input.latencyMs, exactSecret: usage.exactSecret });
    });
  }

  async appendUsage(input: { workspaceId: string; invocationId: string; attempt: StartedAttempt; snapshot: ExecutionSnapshot; status: "SUCCEEDED" | "FAILED"; usage?: ProviderUsage; remoteRequestId?: string; latencyMs: number; exactSecret?: string }): Promise<void> {
    await this.appendUsageWithClient(this.db, input);
  }
  private async appendUsageWithClient(db: Pick<Db, "providerUsageEvent">, input: { workspaceId: string; invocationId: string; attempt: StartedAttempt; snapshot: ExecutionSnapshot; status: "SUCCEEDED" | "FAILED"; usage?: ProviderUsage; remoteRequestId?: string; latencyMs: number; exactSecret?: string }): Promise<void> {
    if (!input.usage) return;
    const metadata = input.usage.extra ? redactSecrets(input.usage.extra, { exactSecrets: input.exactSecret ? [input.exactSecret] : [] }) : undefined;
    if (metadata && JSON.stringify(metadata).length > 8_192) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Provider usage metadata exceeds its safety bound");
    await db.providerUsageEvent.create({ data: { workspaceId: input.workspaceId, invocationId: input.invocationId, attemptId: input.attempt.id, attemptNumber: input.attempt.attemptNumber, providerKey: input.snapshot.providerKey, connectionId: input.snapshot.connectionId, modelId: input.snapshot.modelId, capability: input.snapshot.capability.families.join(","), routeSlot: input.snapshot.routeSlot, status: input.status, inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens, embeddingInputTokens: input.usage.embeddingInputTokens, speechInputCharacters: input.usage.speechInputCharacters, audioDurationMs: input.usage.audioDurationMs, latencyMs: input.usage.latencyMs ?? Math.max(0, Math.round(input.latencyMs)), remoteRequestId: bounded(input.remoteRequestId), metadata: metadata as never } });
  }

  async completeInvocation(workspaceId: string, invocationId: string, claimToken: string, status: "SUCCEEDED" | "FAILED" | "BLOCKED" | "RECONCILIATION_REQUIRED"): Promise<void> {
    await this.db.$transaction(async tx => { await this.assertOwnershipInTransaction(tx, workspaceId, invocationId, claimToken); const now = await this.databaseNow(); await tx.providerInvocation.update({ where: { id_workspaceId: { id: invocationId, workspaceId } }, data: { status, claimToken: null, claimOwner: null, claimExpiresAt: null, completedAt: now } }); });
  }

  async loadExecutionSnapshot(workspaceId: string, snapshotId: string): Promise<ExecutionSnapshot> {
    const snapshot = await this.db.providerExecutionSnapshot.findUnique({ where: { id_workspaceId: { id: snapshotId, workspaceId } } });
    if (!snapshot) throw new ProviderGatewayError("ROUTE_UNAVAILABLE");
    return { ...snapshot, source: snapshot.connectionId ? "WORKSPACE" : "PLATFORM", connectionId: snapshot.connectionId ?? undefined, credentialVersionId: snapshot.credentialVersionId ?? undefined, endpoint: snapshot.endpoint ?? undefined, region: snapshot.region ?? undefined, promptVersion: snapshot.promptVersion ?? undefined, schemaVersion: snapshot.schemaVersion ?? undefined, pipelineVersion: snapshot.pipelineVersion ?? undefined, routeSlot: snapshot.routeSlot as ExecutionSnapshot["routeSlot"], protocol: snapshot.protocol as ExecutionSnapshot["protocol"], capability: snapshot.capability as unknown as ExecutionSnapshot["capability"], configuration: snapshot.configuration as unknown as ExecutionSnapshot["configuration"] };
  }
  async completeSuccessfulEmbeddingExecution(input: { workspaceId: string; invocationId: string; claimToken: string; attempt: StartedAttempt; snapshot: ExecutionSnapshot; response: EmbeddingResponse; expectedVectorCount: number; pinnedDimensions: number; usage?: ProviderUsage; remoteRequestId?: string; latencyMs: number; exactSecret?: string }): Promise<void> {
    this.assertEmbeddingResultStorageAvailable();
    const cipher = this.cipher as CredentialCipher & EmbeddingResultCipher;
    if (input.response.dimensions !== input.pinnedDimensions) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE");
    const vectors = validateVectors(input.response.vectors, input.expectedVectorCount, input.pinnedDimensions);
    const payload = JSON.stringify({ vectors, dimensions: input.response.dimensions, providerModel: input.response.providerModel });
    // 8 MiB is an absolute cap in addition to provider input/dimension constraints; no result is truncated.
    if (Buffer.byteLength(payload, "utf8") > 8 * 1024 * 1024) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Embedding result exceeds durable handoff bound");
    const encrypted = cipher.encryptEmbeddingResult(payload, { workspaceId: input.workspaceId, invocationId: input.invocationId, attemptId: input.attempt.id, snapshotId: input.snapshot.id, providerKey: input.snapshot.providerKey, modelId: input.snapshot.modelId });
    await this.db.$transaction(async tx => {
      await this.assertOwnershipInTransaction(tx, input.workspaceId, input.invocationId, input.claimToken);
      const now = await this.databaseNow();
      const attempt = await tx.providerInvocationAttempt.updateMany({ where: { id: input.attempt.id, invocationId: input.invocationId, workspaceId: input.workspaceId, status: "RUNNING" }, data: { status: "SUCCEEDED", remoteRequestId: bounded(input.remoteRequestId), latencyMs: Math.max(0, Math.min(Math.round(input.latencyMs), 86_400_000)), completedAt: now } });
      if (attempt.count !== 1) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Attempt finalization was not owned");
      if (input.usage) await this.appendUsageWithClient(tx, { workspaceId: input.workspaceId, invocationId: input.invocationId, attempt: input.attempt, snapshot: input.snapshot, status: "SUCCEEDED", usage: input.usage, remoteRequestId: input.remoteRequestId, latencyMs: input.latencyMs, exactSecret: input.exactSecret });
      await tx.providerEmbeddingResult.create({ data: { id: randomUUID(), workspaceId: input.workspaceId, invocationId: input.invocationId, attemptId: input.attempt.id, snapshotId: input.snapshot.id, ...encrypted, vectorCount: vectors.length, dimensions: input.response.dimensions } });
      await tx.providerInvocation.update({ where: { id_workspaceId: { id: input.invocationId, workspaceId: input.workspaceId } }, data: { status: "SUCCEEDED", claimToken: null, claimOwner: null, claimExpiresAt: null, completedAt: now } });
    });
  }
  async recoverEmbeddingResult(workspaceId: string, invocationId: string): Promise<EmbeddingResponse | undefined> {
    if (!this.cipher?.decryptEmbeddingResult) return undefined;
    const row = await this.db.providerEmbeddingResult.findFirst({ where: { workspaceId, invocationId }, include: { snapshot: true } });
    if (!row) return undefined;
    try {
      const plain = this.cipher.decryptEmbeddingResult(row, { workspaceId, invocationId, attemptId: row.attemptId, snapshotId: row.snapshotId, providerKey: row.snapshot.providerKey, modelId: row.snapshot.modelId });
      const parsed = JSON.parse(plain) as { vectors?: unknown; dimensions?: unknown; providerModel?: unknown };
      if (typeof parsed.dimensions !== "number" || !Number.isSafeInteger(parsed.dimensions) || typeof parsed.providerModel !== "string" && parsed.providerModel !== undefined) return undefined;
      const pinnedDimensions = embeddingDimensions(row.snapshot.capability as unknown as ModelCapability, row.snapshot.configuration as Readonly<Record<string, unknown>>);
      if (parsed.dimensions !== row.dimensions || parsed.dimensions !== pinnedDimensions || row.dimensions !== pinnedDimensions) return undefined;
      const vectors = validateVectors(parsed.vectors, row.vectorCount, pinnedDimensions);
      if (vectors.length !== row.vectorCount) return undefined;
      return { vectors, dimensions: parsed.dimensions, providerModel: parsed.providerModel };
    } catch { return undefined; }
  }
  private async assertOwnershipInTransaction(tx: Pick<Db, "$queryRaw">, workspaceId: string, invocationId: string, claimToken: string): Promise<void> {
    if (this.testClock) { const owned = await (tx as Db).providerInvocation.findFirst({ where: { id: invocationId, workspaceId, claimToken, status: "RUNNING", claimExpiresAt: { gt: this.testClock() } }, select: { id: true } }); if (!owned) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership was lost"); return; }
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "ProviderInvocation" WHERE "id" = ${invocationId} AND "workspaceId" = ${workspaceId} AND "claimToken" = ${claimToken} AND "status" = 'RUNNING' AND "claimExpiresAt" > CURRENT_TIMESTAMP FOR UPDATE`;
    if (rows.length !== 1) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership was lost");
  }
}

function snapshotData(snapshot: ExecutionSnapshot) { return { id: snapshot.id, workspaceId: snapshot.workspaceId, routeSlot: snapshot.routeSlot, providerKey: snapshot.providerKey, protocol: snapshot.protocol, modelId: snapshot.modelId, connectionId: snapshot.connectionId, credentialVersionId: snapshot.credentialVersionId, endpoint: snapshot.endpoint, region: snapshot.region, capability: snapshot.capability as never, configuration: snapshot.configuration as never, configurationHash: snapshot.configurationHash, adapterVersion: snapshot.adapterVersion, promptVersion: snapshot.promptVersion, schemaVersion: snapshot.schemaVersion, pipelineVersion: snapshot.pipelineVersion, correlationId: snapshot.correlationId, createdAt: snapshot.createdAt }; }

export function testExecutionRepository(): ProviderExecutionRepository { return new ProviderExecutionRepository(prisma, new VersionedAesGcmCipher("test-v1", new Map([["test-v1", Buffer.alloc(32, 7)]]))); }
