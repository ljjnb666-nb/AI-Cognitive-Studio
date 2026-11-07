import { prisma, type Prisma } from "@ai-cognitive/db";
import { ProviderGatewayError } from "./errors.js";
import { routeSlotCapabilities, validateRouteManifestSelection, type ProviderModelManifest } from "./model-manifest.js";
import { stableHash } from "./routing/snapshot.js";
import { routeSlots, type RouteSlot } from "./types.js";

export type FailoverPreferenceCandidate = {
  connectionId: string;
  modelId: string;
  /** Public adapter settings only. Never contain keys or secret material. */
  configuration: Record<string, unknown>;
};
export type FailoverPreferenceInput = {
  routeSlot: RouteSlot;
  requestedEnabled: boolean;
  maxSwitches: number;
  candidates: FailoverPreferenceCandidate[];
  /** CAS: null for a new preference; a known revision to update. */
  expectedRevision: number | null;
};

const confidentialField = /(^|[_-])(secret|token|password|api[_-]?key|credential|authorization)([_-]|$)/i;
const jsonRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
function assertPublicSettings(value: Record<string, unknown>): void {
  if (JSON.stringify(value).length > 4096) throw new ProviderGatewayError("INVALID_PROVIDER_REQUEST");
  const visit = (entry: unknown, depth: number): void => {
    if (depth > 8) throw new ProviderGatewayError("INVALID_PROVIDER_REQUEST");
    if (Array.isArray(entry)) return entry.forEach(item => visit(item, depth + 1));
    if (entry && typeof entry === "object") for (const [key, item] of Object.entries(entry)) {
      if (confidentialField.test(key)) throw new ProviderGatewayError("INVALID_PROVIDER_REQUEST");
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
}
function assertInput(input: FailoverPreferenceInput): void {
  if (!routeSlots.includes(input.routeSlot) ||
      !Number.isSafeInteger(input.maxSwitches) || input.maxSwitches < 0 || input.maxSwitches > 2 ||
      !Array.isArray(input.candidates) || input.candidates.length > 2 ||
      input.maxSwitches > input.candidates.length ||
      (input.requestedEnabled && input.maxSwitches === 0) ||
      (input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)))
    throw new ProviderGatewayError("INVALID_PROVIDER_REQUEST");
  const ids = new Set<string>();
  for (const item of input.candidates) {
    if (!item || typeof item.connectionId !== "string" || !item.connectionId.trim() ||
        typeof item.modelId !== "string" || !item.modelId.trim() ||
        item.modelId.length > 200 || !jsonRecord(item.configuration))
      throw new ProviderGatewayError("INVALID_PROVIDER_REQUEST");
    if (ids.has(item.connectionId + "\u0000" + item.modelId)) throw new ProviderGatewayError("INVALID_PROVIDER_REQUEST");
    ids.add(item.connectionId + "\u0000" + item.modelId);
    assertPublicSettings(item.configuration);
  }
}

/** Read-only, never implies the execution worker is enabled. */
export async function listWorkspaceFailoverPreferences(workspaceId: string, db: typeof prisma = prisma) {
  const rows = await db.providerFailoverPreference.findMany({
    where: { workspaceId }, orderBy: { routeSlot: "asc" },
  });
  return rows.map(row => ({
    routeSlot: row.routeSlot,
    requestedEnabled: row.requestedEnabled,
    maxSwitches: row.maxSwitches,
    candidates: row.candidates,
    revision: row.revision,
    preferenceHash: row.preferenceHash,
    /** No workflow currently invokes the failover runtime adapter. */
    executionEnabled: false as const,
  }));
}

/**
 * Saves a validated, revisioned workspace preference with owner authority.
 * This deliberately does not create a Gateway invocation or enable retries.
 * Worker execution must later build a fresh pinned plan and re-check permission,
 * credentials, budget, moderation outcome and paid receipts.
 */
export async function saveWorkspaceFailoverPreference(
  context: { workspaceId: string; userId: string },
  input: FailoverPreferenceInput,
  manifest: ProviderModelManifest,
  db: typeof prisma = prisma,
) {
  assertInput(input);
  return db.$transaction(async tx => {
    // Serialize owner changes and forbid a stale editor tab from overwriting
    // a newer candidate list. All workspace choices remain tenant scoped.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Workspace" WHERE "id"=${context.workspaceId} FOR UPDATE`;
    if (locked.length !== 1) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
    const member = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: context.userId } },
      select: { role: true },
    });
    if (member?.role !== "OWNER") throw new ProviderGatewayError("AUTHORIZATION_FAILED");
    const where = { workspaceId_routeSlot: { workspaceId: context.workspaceId, routeSlot: input.routeSlot } };
    const existing = await tx.providerFailoverPreference.findUnique({ where });
    if ((existing?.revision ?? null) !== input.expectedRevision)
      throw new ProviderGatewayError("PROVIDER_CONNECTION_CHANGED");

    const ids = [...new Set(input.candidates.map(candidate => candidate.connectionId))];
    const connections = await tx.providerConnection.findMany({
      where: { workspaceId: context.workspaceId, id: { in: ids } },
      include: { credentialVersions: { where: { status: "ACTIVE" }, take: 1, orderBy: { credentialVersion: "desc" } } },
    });
    if (connections.length !== ids.length) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
    const byId = new Map(connections.map(connection => [connection.id, connection]));
    const primary = await tx.providerRouteBinding.findUnique({
      where: { workspaceId_routeSlot: { workspaceId: context.workspaceId, routeSlot: input.routeSlot } },
      include: { connection: { select: { providerKey: true } } },
    });
    const selected = new Set<string>();
    for (const candidate of input.candidates) {
      const connection = byId.get(candidate.connectionId);
      if (!connection) throw new ProviderGatewayError("AUTHORIZATION_FAILED");
      if (connection.status !== "ACTIVE") throw new ProviderGatewayError("CONNECTION_DISABLED");
      if (!connection.credentialVersions.length) throw new ProviderGatewayError("AUTHENTICATION_FAILED");
      const model = validateRouteManifestSelection(manifest, {
        routeSlot: input.routeSlot, providerKey: connection.providerKey,
        protocol: connection.protocol, modelId: candidate.modelId, configuration: candidate.configuration,
      });
      if (model.deprecated || model.retired) throw new ProviderGatewayError("MODEL_NOT_FOUND");
      if (routeSlotCapabilities[input.routeSlot] === "TEXT_GENERATION" &&
          ["PODCAST_SCRIPT", "SHORT_VIDEO_SCRIPT", "THINKING_SESSION", "BOOK_SEMANTIC_REVIEW"].includes(input.routeSlot) &&
          model.structuredOutput !== "JSON_MODE" && model.structuredOutput !== "STRICT_JSON_SCHEMA")
        throw new ProviderGatewayError("CAPABILITY_MISMATCH");
      const identity = connection.providerKey + "\u0000" + candidate.modelId;
      if (selected.has(identity) ||
          (primary && primary.connection.providerKey === connection.providerKey && primary.modelId === candidate.modelId))
        throw new ProviderGatewayError("CAPABILITY_MISMATCH");
      selected.add(identity);
    }
    const preferenceHash = stableHash({
      version: 1, routeSlot: input.routeSlot, requestedEnabled: input.requestedEnabled,
      maxSwitches: input.maxSwitches, candidates: input.candidates,
    });
    const data = {
      requestedEnabled: input.requestedEnabled,
      maxSwitches: input.maxSwitches, candidates: input.candidates as Prisma.InputJsonValue,
      preferenceHash, updatedByUserId: context.userId,
    };
    const saved = existing
      ? await tx.providerFailoverPreference.update({ where, data: { ...data, revision: { increment: 1 } } })
      : await tx.providerFailoverPreference.create({
        data: { ...data, workspaceId: context.workspaceId, routeSlot: input.routeSlot, revision: 1 },
      });
    await tx.providerAuditEvent.create({
      data: {
        workspaceId: context.workspaceId, actorUserId: context.userId, action: "ROUTING_UPDATED",
        targetType: "ProviderFailoverPreference", targetId: input.routeSlot,
        metadata: {
          preferenceRevision: saved.revision, preferenceHash, intentOnly: true,
          routeSlot: input.routeSlot, requestedEnabled: input.requestedEnabled,
          backupCount: input.candidates.length, maxSwitches: input.maxSwitches,
        },
      },
    });
    return {
      routeSlot: saved.routeSlot, requestedEnabled: saved.requestedEnabled,
      maxSwitches: saved.maxSwitches, candidates: saved.candidates,
      revision: saved.revision, preferenceHash: saved.preferenceHash, executionEnabled: false as const,
    };
  });
}
