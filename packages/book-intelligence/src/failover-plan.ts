import { prisma } from "@ai-cognitive/db";
import { stableHash, validateRouteManifestSelection, type ProviderModelManifest } from "@ai-cognitive/provider-gateway";
import type { BookAnalysisRoutePlan, BookRoutePlanEntry } from "./route-plan.js";

export const bookFailoverTextSlots = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"] as const;
export type BookFailoverTextSlot = (typeof bookFailoverTextSlots)[number];
export type FrozenBookFailoverSlot = {
  preferenceRevision: number;
  preferenceHash: string;
  requestedEnabled: true;
  maxSwitches: 1 | 2;
  /** The primary route is always candidate 0; at most two verified backups follow. */
  candidates: BookRoutePlanEntry[];
};
/**
 * This is a sealed INTENT, not a paid-call authorization or an executable
 * switching plan. Runtime execution remains disabled until a separate,
 * audited durable Worker executor exists.
 */
export type FrozenBookFailoverPlan = {
  version: 1;
  executionEnabled: false;
  primaryPlanHash: string;
  slots: Partial<Record<BookFailoverTextSlot, FrozenBookFailoverSlot>>;
  integrityHash: string;
};

type BackupCandidate = { connectionId: string; modelId: string; configuration: Record<string, unknown> };
type PreferenceRow = {
  routeSlot: string; requestedEnabled: boolean; maxSwitches: number; revision: number;
  preferenceHash: string; candidates: unknown;
};
type ConnectionRow = {
  id: string; providerKey: string; protocol: string; status: string; endpoint: string | null;
  region: string | null; credentialVersions: { id: string; status: string }[];
};
const fail = (): never => { throw new Error("BOOK_FAILOVER_PLAN_INTEGRITY_FAILED"); };
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const safeEndpoint = (value: string | null): value is string => {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
};
const privateField = /(^|[_-])(secret|token|password|api[_-]?key|credential|authorization)([_-]|$)/i;
function assertPublicConfiguration(value: unknown): asserts value is Record<string, unknown> {
  if (!record(value)) fail();
  const visit = (entry: unknown, depth: number): void => {
    if (depth > 8) fail();
    if (Array.isArray(entry)) { for (const item of entry) visit(item, depth + 1); return; }
    if (record(entry)) for (const [key, item] of Object.entries(entry)) {
      if (privateField.test(key)) fail();
      visit(item, depth + 1);
    }
  };
  if (JSON.stringify(value).length > 4096) fail();
  visit(value, 0);
}
const hasTextSlot = (slot: string): slot is BookFailoverTextSlot =>
  bookFailoverTextSlots.some(item => item === slot);

/** Verify both primary binding and every backup locator before a Worker reads the intent. */
export function verifyFrozenBookFailoverPlan(value: unknown, primary: BookAnalysisRoutePlan): FrozenBookFailoverPlan {
  try {
    if (!record(value) || value.version !== 1 || value.executionEnabled !== false ||
        !record(value.slots) || !primary.integrityHash || value.primaryPlanHash !== primary.integrityHash ||
        typeof value.integrityHash !== "string" || !/^[a-f0-9]{64}$/.test(value.integrityHash)) fail();
    if (stableHash({
      version: value.version, executionEnabled: value.executionEnabled,
      primaryPlanHash: value.primaryPlanHash, slots: value.slots,
    }) !== value.integrityHash) fail();
    for (const [name, rawSlot] of Object.entries(value.slots)) {
      if (!hasTextSlot(name) || !record(rawSlot) ||
          rawSlot.requestedEnabled !== true ||
          !Number.isSafeInteger(rawSlot.preferenceRevision) || Number(rawSlot.preferenceRevision) < 1 ||
          typeof rawSlot.preferenceHash !== "string" || !/^[a-f0-9]{64}$/.test(rawSlot.preferenceHash) ||
          (rawSlot.maxSwitches !== 1 && rawSlot.maxSwitches !== 2) ||
          !Array.isArray(rawSlot.candidates) ||
          rawSlot.candidates.length !== Number(rawSlot.maxSwitches) + 1) fail();
      const seen = new Set<string>();
      for (const [index, candidate] of rawSlot.candidates.entries()) {
        if (!record(candidate) || !record(candidate.configuration) ||
            typeof candidate.providerKey !== "string" || !candidate.providerKey ||
            typeof candidate.modelId !== "string" || !candidate.modelId ||
            typeof candidate.connectionId !== "string" || !candidate.connectionId ||
            typeof candidate.credentialVersionId !== "string" || !candidate.credentialVersionId ||
            typeof candidate.endpoint !== "string" || !safeEndpoint(candidate.endpoint) ||
            typeof candidate.configurationHash !== "string" ||
            candidate.configurationHash !== stableHash(candidate.configuration)) fail();
        assertPublicConfiguration(candidate.configuration);
        const modelIdentity = candidate.providerKey + "\u0000" + candidate.modelId;
        if (seen.has(modelIdentity)) fail();
        seen.add(modelIdentity);
        if (index === 0 && stableHash(candidate) !== stableHash(primary.routes[name])) fail();
      }
    }
    return value as unknown as FrozenBookFailoverPlan;
  } catch { return fail(); }
}

/**
 * Pure compiler; persisted rows and connections MUST be fetched using the same
 * trusted workspace ID. A missing/invalid configured backup fails closed.
 */
export function sealFrozenBookFailoverPlan(
  primary: BookAnalysisRoutePlan,
  preferences: readonly PreferenceRow[],
  connections: readonly ConnectionRow[],
  manifest: ProviderModelManifest,
): FrozenBookFailoverPlan | undefined {
  const active = preferences.filter(row => hasTextSlot(row.routeSlot) && row.requestedEnabled);
  if (!active.length) return undefined;
  const byId = new Map(connections.map(connection => [connection.id, connection]));
  const slots: FrozenBookFailoverPlan["slots"] = {};
  for (const preference of active) {
    const name = preference.routeSlot as BookFailoverTextSlot;
    if (slots[name] || !Number.isSafeInteger(preference.revision) || preference.revision < 1 ||
        (preference.maxSwitches !== 1 && preference.maxSwitches !== 2) ||
        !Array.isArray(preference.candidates) ||
        preference.candidates.length < preference.maxSwitches ||
        preference.candidates.length > 2 ||
        stableHash({
          version: 1, routeSlot: name, requestedEnabled: preference.requestedEnabled,
          maxSwitches: preference.maxSwitches, candidates: preference.candidates,
        }) !== preference.preferenceHash) fail();
    const candidates: BookRoutePlanEntry[] = [primary.routes[name]];
    const seen = new Set([primary.routes[name].providerKey + "\u0000" + primary.routes[name].modelId]);
    for (const item of (preference.candidates as BackupCandidate[]).slice(0, preference.maxSwitches)) {
      if (!record(item) || typeof item.connectionId !== "string" ||
          typeof item.modelId !== "string" || !item.modelId.trim()) fail();
      assertPublicConfiguration(item.configuration);
      const connection = byId.get(item.connectionId);
      if (!connection || connection.status !== "ACTIVE" ||
          !safeEndpoint(connection.endpoint) || connection.credentialVersions.length !== 1 ||
          connection.credentialVersions[0]?.status !== "ACTIVE") fail();
      const provider = manifest.providers.find(entry => entry.providerKey === connection.providerKey);
      if (!provider) fail();
      const model = validateRouteManifestSelection(manifest, {
        routeSlot: name, providerKey: connection.providerKey, protocol: connection.protocol,
        modelId: item.modelId, configuration: item.configuration,
      });
      if (model.deprecated || model.retired ||
          (model.structuredOutput !== "STRICT_JSON_SCHEMA" && model.structuredOutput !== "JSON_MODE")) fail();
      const identity = connection.providerKey + "\u0000" + item.modelId;
      if (seen.has(identity)) fail();
      seen.add(identity);
      candidates.push({
        providerKey: connection.providerKey, protocol: connection.protocol, modelId: item.modelId,
        ...(typeof item.configuration.modelVersion === "string" && item.configuration.modelVersion
          ? { modelVersion: item.configuration.modelVersion } : {}),
        configuration: item.configuration, configurationHash: stableHash(item.configuration),
        structuredOutput: model.structuredOutput,
        connectionId: connection.id, credentialVersionId: connection.credentialVersions[0]!.id,
        endpoint: connection.endpoint, ...(connection.region ? { region: connection.region } : {}),
        adapterVersion: provider.adapterVersion,
      });
    }
    slots[name] = {
      preferenceRevision: preference.revision, preferenceHash: preference.preferenceHash,
      requestedEnabled: true, maxSwitches: preference.maxSwitches, candidates,
    };
  }
  const unsigned = { version: 1 as const, executionEnabled: false as const, primaryPlanHash: primary.integrityHash!, slots };
  return verifyFrozenBookFailoverPlan(
    { ...unsigned, integrityHash: stableHash(unsigned) }, primary,
  );
}

/** New Book jobs snapshot user intent; no other stage is authorized to switch. */
export async function loadFrozenBookFailoverPlan(
  workspaceId: string, primary: BookAnalysisRoutePlan, manifest: ProviderModelManifest,
): Promise<FrozenBookFailoverPlan | undefined> {
  const rows = await prisma.providerFailoverPreference.findMany({
    where: { workspaceId, routeSlot: { in: [...bookFailoverTextSlots] }, requestedEnabled: true },
    orderBy: { routeSlot: "asc" },
  });
  if (!rows.length) return undefined;
  const ids = [...new Set(rows.flatMap(row =>
    Array.isArray(row.candidates) ? row.candidates.flatMap(item =>
      record(item) && typeof item.connectionId === "string" ? [item.connectionId] : []) : []))];
  const connections = await prisma.providerConnection.findMany({
    where: { workspaceId, id: { in: ids } },
    include: { credentialVersions: {
      where: { status: "ACTIVE" }, orderBy: { credentialVersion: "desc" }, take: 1,
      select: { id: true, status: true },
    } },
  });
  return sealFrozenBookFailoverPlan(primary, rows, connections, manifest);
}
