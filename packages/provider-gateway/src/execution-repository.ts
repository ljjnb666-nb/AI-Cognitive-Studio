import { prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { VersionedAesGcmCipher, type CredentialCipher } from "./credentials/cipher.js";
import { redactSecrets } from "./credentials/redaction.js";
import { ProviderGatewayError } from "./errors.js";
import type { ExecutionSnapshot, ProviderUsage } from "./types.js";

type Db = typeof prisma;
export type ExecutionClaim = { kind: "OWNER"; invocationId: string; claimToken: string } | { kind: "ALREADY_PROCESSED"; invocationId: string } | { kind: "IN_PROGRESS"; invocationId: string } | { kind: "TERMINAL_FAILED"; invocationId: string } | { kind: "BLOCKED_EXISTING"; invocationId: string } | { kind: "RECONCILIATION_REQUIRED"; invocationId: string };
export type StartedAttempt = { id: string; attemptNumber: number };
const leaseMilliseconds = 60_000;
const bounded = (value: string | undefined) => value && value.length <= 256 ? value : undefined;
const uniqueViolation = (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";

export class ProviderExecutionRepository {
  constructor(private readonly db: Db = prisma, private readonly cipher?: CredentialCipher, private readonly testClock?: () => Date, private readonly workerId = `gateway-${randomUUID()}`, private readonly leaseMs = leaseMilliseconds) {}
  private async databaseNow(): Promise<Date> { if (this.testClock) return this.testClock(); const rows = await this.db.$queryRaw<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP AS "now"`; return rows[0]?.now ?? (() => { throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Database clock unavailable"); })(); }
  get leaseDurationMs(): number { return this.leaseMs; }

  async claimExecution(snapshot: ExecutionSnapshot, input: { idempotencyKey: string; fingerprint: string }): Promise<ExecutionClaim> {
    const claimToken = randomUUID(); const now = await this.databaseNow(); const expiresAt = new Date(now.getTime() + this.leaseMs);
    try {
      const invocation = await this.db.$transaction(async tx => {
        await tx.providerExecutionSnapshot.create({ data: snapshotData(snapshot) });
        return tx.providerInvocation.create({ data: { id: randomUUID(), workspaceId: snapshot.workspaceId, snapshotId: snapshot.id, connectionId: snapshot.connectionId, credentialVersionId: snapshot.credentialVersionId, providerKey: snapshot.providerKey, protocol: snapshot.protocol, modelId: snapshot.modelId, routeSlot: snapshot.routeSlot, idempotencyKey: input.idempotencyKey, requestFingerprint: input.fingerprint, correlationId: snapshot.correlationId, status: "RUNNING", claimToken, claimOwner: this.workerId, claimExpiresAt: expiresAt } });
      });
      return { kind: "OWNER", invocationId: invocation.id, claimToken };
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
    }
    const existing = await this.db.providerInvocation.findUnique({ where: { workspaceId_idempotencyKey: { workspaceId: snapshot.workspaceId, idempotencyKey: input.idempotencyKey }, }, include: { attempts: { select: { id: true, status: true } } } });
    if (!existing) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR");
    if (existing.requestFingerprint !== input.fingerprint) throw new ProviderGatewayError("IDEMPOTENCY_CONFLICT");
    if (existing.status === "SUCCEEDED") return { kind: "ALREADY_PROCESSED", invocationId: existing.id };
    if (existing.status === "FAILED") return { kind: "TERMINAL_FAILED", invocationId: existing.id };
    if (existing.status === "BLOCKED") return { kind: "BLOCKED_EXISTING", invocationId: existing.id };
    if (existing.status === "RECONCILIATION_REQUIRED") return { kind: "RECONCILIATION_REQUIRED", invocationId: existing.id };
    if (existing.status === "RUNNING" && existing.claimExpiresAt && existing.claimExpiresAt > now) return { kind: "IN_PROGRESS", invocationId: existing.id };
    if (existing.attempts.some(attempt => attempt.status === "RUNNING" || attempt.status === "REMOTE_OUTCOME_UNKNOWN")) { await this.markStaleAttemptUnknown(snapshot.workspaceId, existing.id); return { kind: "RECONCILIATION_REQUIRED", invocationId: existing.id }; }
    if (existing.attempts.some(attempt => attempt.status === "SUCCEEDED")) return { kind: "RECONCILIATION_REQUIRED", invocationId: existing.id };
    if (existing.attempts.length > 0) return { kind: existing.attempts.every(attempt => attempt.status === "REMOTE_FAILURE") ? "TERMINAL_FAILED" : "RECONCILIATION_REQUIRED", invocationId: existing.id };
    if (existing.attempts.length === 0 && (existing.status === "PENDING" || (existing.claimExpiresAt && existing.claimExpiresAt <= now))) {
      const reclaimed = await this.db.providerInvocation.updateMany({ where: { id: existing.id, workspaceId: snapshot.workspaceId, claimToken: existing.claimToken ?? undefined, status: existing.status, OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lte: now } }] }, data: { status: "RUNNING", claimToken, claimOwner: this.workerId, claimExpiresAt: expiresAt, completedAt: null } });
      if (reclaimed.count === 1) return { kind: "OWNER", invocationId: existing.id, claimToken };
    }
    return { kind: "IN_PROGRESS", invocationId: existing.id };
  }

  async assertExecutionOwnership(workspaceId: string, invocationId: string, claimToken: string): Promise<void> {
    const now = await this.databaseNow(); const owned = await this.db.providerInvocation.findFirst({ where: { id: invocationId, workspaceId, claimToken, status: "RUNNING", claimExpiresAt: { gt: now } }, select: { id: true } });
    if (!owned) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership was lost");
  }

  async renewClaim(workspaceId: string, invocationId: string, claimToken: string): Promise<void> { const now = await this.databaseNow(); const updated = await this.db.providerInvocation.updateMany({ where: { id: invocationId, workspaceId, claimToken, status: "RUNNING", claimExpiresAt: { gt: now } }, data: { claimExpiresAt: new Date(now.getTime() + this.leaseMs) } }); if (updated.count !== 1) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership was lost"); }
  async releasePreRemoteClaim(workspaceId: string, invocationId: string, claimToken: string): Promise<void> { const updated = await this.db.providerInvocation.updateMany({ where: { id: invocationId, workspaceId, claimToken, status: "RUNNING", attempts: { none: {} } }, data: { status: "PENDING", claimToken: null, claimOwner: null, claimExpiresAt: null } }); if (updated.count !== 1) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership was lost"); }
  async markStaleAttemptUnknown(workspaceId: string, invocationId: string): Promise<boolean> { return this.db.$transaction(async tx => { const rows = await tx.$queryRaw<{ status: string; claimExpiresAt: Date | null }[]>`SELECT "status", "claimExpiresAt" FROM "ProviderInvocation" WHERE "id" = ${invocationId} AND "workspaceId" = ${workspaceId} FOR UPDATE`; const current = rows[0]; const clockRows = await tx.$queryRaw<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP AS "now"`; const now = this.testClock ? this.testClock() : clockRows[0]?.now; if (!current || !now || current.status !== "RUNNING" || !current.claimExpiresAt || current.claimExpiresAt > now) return false; await tx.providerInvocationAttempt.updateMany({ where: { workspaceId, invocationId, status: "RUNNING" }, data: { status: "REMOTE_OUTCOME_UNKNOWN", completedAt: now, failureCode: "REMOTE_OUTCOME_UNKNOWN" } }); await tx.providerInvocation.update({ where: { id_workspaceId: { id: invocationId, workspaceId } }, data: { status: "RECONCILIATION_REQUIRED", claimToken: null, claimOwner: null, claimExpiresAt: null, completedAt: now } }); return true; }); }
  async startAttempt(workspaceId: string, invocationId: string, claimToken: string): Promise<StartedAttempt> {
    return this.db.$transaction(async tx => {
      const now = await this.databaseNow(); const invocation = await tx.providerInvocation.findFirst({ where: { id: invocationId, workspaceId, claimToken, status: "RUNNING", claimExpiresAt: { gt: now } }, select: { id: true } });
      if (!invocation) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Execution ownership was lost");
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
    const now = await this.databaseNow();
    const updated = await this.db.providerInvocationAttempt.updateMany({ where: { id: attemptId, invocationId, workspaceId, status: "RUNNING", invocation: { is: { claimToken, status: "RUNNING", claimExpiresAt: { gt: now } } } }, data: { status, failureCode: bounded(input.failureCode), remoteRequestId: bounded(input.remoteRequestId), latencyMs: Math.max(0, Math.min(Math.round(input.latencyMs), 86_400_000)), completedAt: now } });
    if (updated.count !== 1) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Attempt finalization was not owned");
  }

  async appendUsage(input: { workspaceId: string; invocationId: string; attempt: StartedAttempt; snapshot: ExecutionSnapshot; status: "SUCCEEDED" | "FAILED"; usage?: ProviderUsage; remoteRequestId?: string; latencyMs: number; exactSecret?: string }): Promise<void> {
    if (!input.usage) return;
    const metadata = input.usage.extra ? redactSecrets(input.usage.extra, { exactSecrets: input.exactSecret ? [input.exactSecret] : [] }) : undefined;
    if (metadata && JSON.stringify(metadata).length > 8_192) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Provider usage metadata exceeds its safety bound");
    await this.db.providerUsageEvent.create({ data: { workspaceId: input.workspaceId, invocationId: input.invocationId, attemptId: input.attempt.id, attemptNumber: input.attempt.attemptNumber, providerKey: input.snapshot.providerKey, connectionId: input.snapshot.connectionId, modelId: input.snapshot.modelId, capability: input.snapshot.capability.families.join(","), routeSlot: input.snapshot.routeSlot, status: input.status, inputTokens: input.usage.inputTokens, outputTokens: input.usage.outputTokens, embeddingInputTokens: input.usage.embeddingInputTokens, speechInputCharacters: input.usage.speechInputCharacters, audioDurationMs: input.usage.audioDurationMs, latencyMs: input.usage.latencyMs ?? Math.max(0, Math.round(input.latencyMs)), remoteRequestId: bounded(input.remoteRequestId), metadata: metadata as never } });
  }

  async completeInvocation(workspaceId: string, invocationId: string, claimToken: string, status: "SUCCEEDED" | "FAILED" | "BLOCKED" | "RECONCILIATION_REQUIRED"): Promise<void> {
    const now = await this.databaseNow(); const updated = await this.db.providerInvocation.updateMany({ where: { id: invocationId, workspaceId, claimToken, status: "RUNNING", claimExpiresAt: { gt: now } }, data: { status, claimToken: null, claimOwner: null, claimExpiresAt: null, completedAt: now } });
    if (updated.count !== 1) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Invocation finalization was not owned");
  }
}

function snapshotData(snapshot: ExecutionSnapshot) { return { id: snapshot.id, workspaceId: snapshot.workspaceId, routeSlot: snapshot.routeSlot, providerKey: snapshot.providerKey, protocol: snapshot.protocol, modelId: snapshot.modelId, connectionId: snapshot.connectionId, credentialVersionId: snapshot.credentialVersionId, endpoint: snapshot.endpoint, region: snapshot.region, capability: snapshot.capability as never, configuration: snapshot.configuration as never, configurationHash: snapshot.configurationHash, adapterVersion: snapshot.adapterVersion, promptVersion: snapshot.promptVersion, schemaVersion: snapshot.schemaVersion, pipelineVersion: snapshot.pipelineVersion, correlationId: snapshot.correlationId, createdAt: snapshot.createdAt }; }

export function testExecutionRepository(): ProviderExecutionRepository { return new ProviderExecutionRepository(prisma, new VersionedAesGcmCipher("test-v1", new Map([["test-v1", Buffer.alloc(32, 7)]]))); }
