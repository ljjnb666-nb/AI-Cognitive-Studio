import { prisma, type Prisma } from "@ai-cognitive/db";
import { randomUUID } from "node:crypto";
import { VersionedAesGcmCipher, type CredentialCipher } from "./credentials/cipher.js";
import { redactSecrets } from "./credentials/redaction.js";
import { ProviderGatewayError } from "./errors.js";
import type { ExecutionSnapshot, GatewayRequest, ResolvedRoute } from "./types.js";

type Db = typeof prisma;
type OwnerContext = { workspaceId: string; userId: string };
async function requireOwner(db: Pick<Db, "workspaceMember">, context: OwnerContext): Promise<void> {
  const membership = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: context.userId } } });
  if (membership?.role !== "OWNER") throw new ProviderGatewayError("AUTHORIZATION_FAILED");
}
async function lockProviderConnections(tx: Prisma.TransactionClient, context: OwnerContext, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ProviderConnection" WHERE "id"=${id} AND "workspaceId"=${context.workspaceId} FOR UPDATE`;
    if (rows.length !== 1) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
  }
}
function hint(secret: string): string { return secret.length >= 4 ? `…${secret.slice(-4)}` : "configured"; }
function boundedMetadata(value: Record<string, unknown>): Record<string, unknown> { const clean = redactSecrets(value) as Record<string, unknown>; if (JSON.stringify(clean).length > 8_192) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Provider metadata exceeds its safety bound"); return clean; }
function isProviderConnectionNameConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; meta?: { target?: unknown } };
  if (value.code !== "P2002") return false;
  const target = value.meta?.target;
  if (Array.isArray(target)) return target.length === 2 && target.includes("workspaceId") && target.includes("displayName");
  return target === "ProviderConnection_workspaceId_displayName_key" || target === "workspaceId_displayName";
}
function normalizeConnectionNameConflict(error: unknown): never { if (isProviderConnectionNameConflict(error)) throw new ProviderGatewayError("PROVIDER_CONNECTION_NAME_CONFLICT"); throw error; }

export class ProviderGatewayRepository {
  constructor(private readonly db: Db = prisma, private readonly cipher?: CredentialCipher) {}
  async createConnection(context: OwnerContext, input: { providerKey: string; protocol: string; displayName: string; endpoint?: string; region?: string; configuration?: Record<string, unknown> }) { await requireOwner(this.db, context); try { const connection = await this.db.providerConnection.create({ data: { providerKey: input.providerKey, protocol: input.protocol, displayName: input.displayName, ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}), ...(input.region !== undefined ? { region: input.region } : {}), configuration: boundedMetadata(input.configuration ?? {}) as never, workspaceId: context.workspaceId } }); await this.audit(context, "CONNECTION_CREATED", "ProviderConnection", connection.id, { providerKey: input.providerKey }); return connection; } catch (error) { normalizeConnectionNameConflict(error); } }
  async createConnectionWithCredential(context: OwnerContext, input: { providerKey: string; protocol: string; displayName: string; endpoint: string; secret: string; region?: string; configuration?: Record<string, unknown> }) {
    if (!this.cipher) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Credential vault is not configured");
    await requireOwner(this.db, context);
    try { return await this.db.$transaction(async tx => {
      const connection = await tx.providerConnection.create({ data: { providerKey: input.providerKey, protocol: input.protocol, displayName: input.displayName, endpoint: input.endpoint, ...(input.region !== undefined ? { region: input.region } : {}), configuration: boundedMetadata(input.configuration ?? {}) as never, workspaceId: context.workspaceId } });
      const credentialId = randomUUID();
      const encrypted = this.cipher!.encrypt(input.secret, { workspaceId: context.workspaceId, connectionId: connection.id, credentialVersionId: credentialId, providerKey: connection.providerKey });
      const credential = await tx.providerCredentialVersion.create({ data: { id: credentialId, workspaceId: context.workspaceId, connectionId: connection.id, credentialVersion: 1, ...encrypted, displayHint: hint(input.secret), status: "ACTIVE" } });
      await tx.providerAuditEvent.createMany({ data: [
        { workspaceId: context.workspaceId, actorUserId: context.userId, action: "CONNECTION_CREATED", targetType: "ProviderConnection", targetId: connection.id, metadata: boundedMetadata({ providerKey: input.providerKey }) as never },
        { workspaceId: context.workspaceId, actorUserId: context.userId, action: "CREDENTIAL_CREATED", targetType: "ProviderCredentialVersion", targetId: credential.id, metadata: {} },
      ] });
      return { connection, credential };
    }); } catch (error) { normalizeConnectionNameConflict(error); }
  }
  async updateConnection(context: OwnerContext, connectionId: string, input: { displayName?: string; endpoint?: string | null; region?: string | null; configuration?: Record<string, unknown> }) { await requireOwner(this.db, context); const connection = await this.db.providerConnection.update({ where: { id_workspaceId: { id: connectionId, workspaceId: context.workspaceId } }, data: { displayName: input.displayName, endpoint: input.endpoint, region: input.region, configuration: input.configuration ? boundedMetadata(input.configuration) as never : undefined } }); await this.audit(context, "CONNECTION_UPDATED", "ProviderConnection", connectionId, { displayName: input.displayName, endpointChanged: input.endpoint !== undefined, regionChanged: input.region !== undefined, configurationChanged: input.configuration !== undefined }); return connection; }
  async deleteConnection(context: OwnerContext, connectionId: string, expected: { routeSlots: readonly string[]; credentialVersionId: string | null }) {
    await requireOwner(this.db, context);
    return this.db.$transaction(async tx => {
      await lockProviderConnections(tx, context, [connectionId]);
      await requireOwner(tx, context);
      const connection = await tx.providerConnection.findUniqueOrThrow({ where: { id_workspaceId: { id: connectionId, workspaceId: context.workspaceId } } });
      if (connection.status === "REVOKED") return { alreadyDeleted: true };
      const routes = await tx.providerRouteBinding.findMany({ where: { workspaceId: context.workspaceId, connectionId }, select: { routeSlot: true } });
      const active = await tx.providerCredentialVersion.findFirst({ where: { workspaceId: context.workspaceId, connectionId, status: "ACTIVE" }, orderBy: { credentialVersion: "desc" }, select: { id: true } });
      if (JSON.stringify(routes.map(route => route.routeSlot).sort()) !== JSON.stringify([...new Set(expected.routeSlots)].sort()) || (active?.id ?? null) !== expected.credentialVersionId) throw new ProviderGatewayError("PROVIDER_CONNECTION_CHANGED");
      await tx.providerConnection.update({ where: { id: connectionId }, data: { status: "REVOKED", displayName: `${connection.displayName.slice(0, 90)} [deleted:${connection.id}]` } });
      const credentials = await tx.providerCredentialVersion.updateMany({ where: { workspaceId: context.workspaceId, connectionId, status: { not: "REVOKED" } }, data: { status: "REVOKED" } });
      await tx.providerRouteBinding.deleteMany({ where: { workspaceId: context.workspaceId, connectionId } });
      await tx.providerAuditEvent.create({ data: { workspaceId: context.workspaceId, actorUserId: context.userId, action: "CONNECTION_UPDATED", targetType: "ProviderConnection", targetId: connectionId, metadata: { deleted: true, displayName: connection.displayName, unboundSlots: routes.map(route => route.routeSlot), revokedCredentials: credentials.count } } });
      return { alreadyDeleted: false };
    });
  }
  async setConnectionEnabled(context: OwnerContext, connectionId: string, enabled: boolean) {
    await requireOwner(this.db, context);
    return this.db.$transaction(async tx => {
      await lockProviderConnections(tx, context, [connectionId]);
      await requireOwner(tx, context);
      const current = await tx.providerConnection.findUniqueOrThrow({ where: { id_workspaceId: { id: connectionId, workspaceId: context.workspaceId } } });
      if (current.status === "REVOKED") throw new ProviderGatewayError("CONNECTION_DISABLED", "Revoked provider connections are terminal");
      const connection = await tx.providerConnection.update({ where: { id: connectionId }, data: { status: enabled ? "ACTIVE" : "DISABLED" } });
      await tx.providerAuditEvent.create({ data: { workspaceId: context.workspaceId, actorUserId: context.userId, action: enabled ? "CONNECTION_ENABLED" : "CONNECTION_DISABLED", targetType: "ProviderConnection", targetId: connectionId, metadata: {} } });
      return connection;
    });
  }
  async rotateCredential(context: OwnerContext, connectionId: string, secret: string) { if (!this.cipher) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Credential vault is not configured"); await requireOwner(this.db, context); const versionId = randomUUID(); return this.db.$transaction(async tx => { await lockProviderConnections(tx, context, [connectionId]); await requireOwner(tx, context); const connection = await tx.providerConnection.findUnique({ where: { id_workspaceId: { id: connectionId, workspaceId: context.workspaceId } } }); if (!connection) throw new ProviderGatewayError("AUTHORIZATION_FAILED"); if (connection.status === "REVOKED") throw new ProviderGatewayError("CONNECTION_DISABLED", "Revoked provider connections cannot rotate credentials"); const latest = await tx.providerCredentialVersion.aggregate({ where: { connectionId, workspaceId: context.workspaceId }, _max: { credentialVersion: true } }); const encrypted = this.cipher!.encrypt(secret, { workspaceId: context.workspaceId, connectionId, credentialVersionId: versionId, providerKey: connection.providerKey }); await tx.providerCredentialVersion.updateMany({ where: { connectionId, workspaceId: context.workspaceId, status: "ACTIVE" }, data: { status: "RETIRED" } }); const credential = await tx.providerCredentialVersion.create({ data: { id: versionId, workspaceId: context.workspaceId, connectionId, credentialVersion: (latest._max.credentialVersion ?? 0) + 1, ...encrypted, displayHint: hint(secret), status: "ACTIVE" } }); await tx.providerAuditEvent.create({ data: { workspaceId: context.workspaceId, actorUserId: context.userId, action: latest._max.credentialVersion === null ? "CREDENTIAL_CREATED" : "CREDENTIAL_ROTATED", targetType: "ProviderCredentialVersion", targetId: credential.id, metadata: {} } }); return credential; }); }
  async revokeCredential(context: OwnerContext, credentialVersionId: string) { await requireOwner(this.db, context); const credential = await this.db.providerCredentialVersion.update({ where: { id_workspaceId: { id: credentialVersionId, workspaceId: context.workspaceId } }, data: { status: "REVOKED" } }); await this.audit(context, "CREDENTIAL_REVOKED", "ProviderCredentialVersion", credentialVersionId, {}); return credential; }
  async setRoute(context: OwnerContext, input: { routeSlot: string; connectionId: string; modelId: string; configuration?: Record<string, unknown> }) {
    return (await this.setRoutesAtomically(context, [input]))[0]!;
  }
  async setRoutesAtomically(context: OwnerContext, inputs: readonly { routeSlot: string; connectionId: string; modelId: string; configuration?: Record<string, unknown> }[]) {
    await requireOwner(this.db, context);
    if (!inputs.length || new Set(inputs.map(input => input.routeSlot)).size !== inputs.length) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Invalid atomic route set");
    const ids = [...new Set(inputs.map(input => input.connectionId))];
    const normalized = inputs.map(input => ({ ...input, configuration: boundedMetadata(input.configuration ?? {}) }));
    return this.db.$transaction(async tx => {
      await lockProviderConnections(tx, context, ids);
      await requireOwner(tx, context);
      const connections = await tx.providerConnection.findMany({ where: { workspaceId: context.workspaceId, id: { in: ids } } });
      if (connections.some(connection => connection.status === "REVOKED")) throw new ProviderGatewayError("CONNECTION_DISABLED");
      const routes = [];
      for (const input of normalized) {
        const route = await tx.providerRouteBinding.upsert({ where: { workspaceId_routeSlot: { workspaceId: context.workspaceId, routeSlot: input.routeSlot } }, create: { routeSlot: input.routeSlot, modelId: input.modelId, configuration: input.configuration as never, workspaceId: context.workspaceId, connectionId: input.connectionId }, update: { connectionId: input.connectionId, modelId: input.modelId, configuration: input.configuration as never } });
        routes.push(route);
        await tx.providerAuditEvent.create({ data: { workspaceId: context.workspaceId, actorUserId: context.userId, action: "ROUTING_UPDATED", targetType: "ProviderRouteBinding", targetId: route.id, metadata: { routeSlot: input.routeSlot, modelId: input.modelId } } });
      }
      return routes;
    });
  }
  async resolveWorkspaceRoute(request: GatewayRequest): Promise<ResolvedRoute | undefined> { const route = await this.db.providerRouteBinding.findUnique({ where: { workspaceId_routeSlot: { workspaceId: request.workspaceId, routeSlot: request.routeSlot } }, include: { connection: true } }); if (!route) return undefined; if (route.connection.status !== "ACTIVE") throw new ProviderGatewayError("CONNECTION_DISABLED"); const credential = await this.db.providerCredentialVersion.findFirst({ where: { connectionId: route.connectionId, workspaceId: request.workspaceId, status: "ACTIVE" }, orderBy: { credentialVersion: "desc" } }); if (!credential) throw new ProviderGatewayError("AUTHENTICATION_FAILED", "No active workspace credential"); return { source: "WORKSPACE", providerKey: route.connection.providerKey, protocol: route.connection.protocol as ResolvedRoute["protocol"], modelId: route.modelId, adapterVersion: "phase8a", connectionId: route.connectionId, credentialVersionId: credential.id, endpoint: route.connection.endpoint ?? undefined, region: route.connection.region ?? undefined, capability: { modelId: route.modelId, families: [], confidence: "DECLARED" }, configuration: route.configuration as Record<string, unknown> }; }
  async persistSnapshot(snapshot: ExecutionSnapshot) { return this.db.providerExecutionSnapshot.create({ data: { id: snapshot.id, workspaceId: snapshot.workspaceId, routeSlot: snapshot.routeSlot, providerKey: snapshot.providerKey, protocol: snapshot.protocol, modelId: snapshot.modelId, connectionId: snapshot.connectionId, credentialVersionId: snapshot.credentialVersionId, endpoint: snapshot.endpoint, region: snapshot.region, capability: snapshot.capability as never, configuration: snapshot.configuration as never, configurationHash: snapshot.configurationHash, adapterVersion: snapshot.adapterVersion, promptVersion: snapshot.promptVersion, schemaVersion: snapshot.schemaVersion, pipelineVersion: snapshot.pipelineVersion, correlationId: snapshot.correlationId, createdAt: snapshot.createdAt } }); }
  async assertSnapshotCredentialUsable(workspaceId: string, snapshotId: string): Promise<void> { const snapshot = await this.db.providerExecutionSnapshot.findUnique({ where: { id_workspaceId: { id: snapshotId, workspaceId } }, include: { credentialVersion: true, connection: true } }); if (!snapshot) throw new ProviderGatewayError("AUTHORIZATION_FAILED"); if (snapshot.connection && snapshot.connection.status !== "ACTIVE") throw new ProviderGatewayError("CONNECTION_DISABLED"); if (snapshot.credentialVersion?.status === "REVOKED") throw new ProviderGatewayError("CREDENTIAL_REVOKED"); }
  /** Validates a resolved workspace route before its execution snapshot is persisted. */
  async assertResolvedRouteUsable(workspaceId: string, connectionId: string | undefined, credentialVersionId: string | undefined): Promise<void> { if (!connectionId || !credentialVersionId) throw new ProviderGatewayError("AUTHORIZATION_FAILED"); const credential = await this.db.providerCredentialVersion.findUnique({ where: { id_workspaceId: { id: credentialVersionId, workspaceId } }, include: { connection: true } }); if (!credential?.connection || credential.connectionId !== connectionId) throw new ProviderGatewayError("AUTHORIZATION_FAILED"); if (credential.connection.status !== "ACTIVE") throw new ProviderGatewayError("CONNECTION_DISABLED"); if (credential.status === "REVOKED") throw new ProviderGatewayError("CREDENTIAL_REVOKED"); }
  async appendUsage(input: { workspaceId: string; invocationId: string; attemptId: string; attemptNumber: number; providerKey: string; connectionId?: string; modelId: string; capability: string; routeSlot: string; status: "SUCCEEDED" | "FAILED"; inputTokens?: number; outputTokens?: number; embeddingInputTokens?: number; speechInputCharacters?: number; audioDurationMs?: number; latencyMs?: number; remoteRequestId?: string; metadata?: Record<string, unknown> }) { return this.db.providerUsageEvent.create({ data: { ...input, metadata: input.metadata ? boundedMetadata(input.metadata) as never : undefined } }); }
  private async audit(context: OwnerContext, action: "CONNECTION_CREATED" | "CONNECTION_UPDATED" | "CONNECTION_DISABLED" | "CONNECTION_ENABLED" | "CREDENTIAL_CREATED" | "CREDENTIAL_REVOKED" | "ROUTING_UPDATED", targetType: string, targetId: string, metadata: Record<string, unknown>) { await this.db.providerAuditEvent.create({ data: { workspaceId: context.workspaceId, actorUserId: context.userId, action, targetType, targetId, metadata: boundedMetadata(metadata) as never } }); }
}

export function testCipher(): VersionedAesGcmCipher { return new VersionedAesGcmCipher("test-v1", new Map([["test-v1", Buffer.alloc(32, 7)]])); }
