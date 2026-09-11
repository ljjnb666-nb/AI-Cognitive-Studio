import { sha256 } from "./chunking.js";

export const bookRouteSlots = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING"] as const;
export type BookRouteSlot = (typeof bookRouteSlots)[number];
export type BookRoutePlanEntry = {
  providerKey: string;
  protocol: string;
  modelId: string;
  modelVersion?: string;
  configuration: Record<string, unknown>;
  configurationHash: string;
  structuredOutput?: "STRICT_JSON_SCHEMA" | "JSON_MODE";
  dimensions?: number;
  connectionId: string;
  credentialVersionId: string;
  endpoint: string;
  region?: string;
  adapterVersion: string;
};
/**
 * `integrityHash` protects every persisted execution locator.  It deliberately
 * is not part of `bookRoutePlanHash`: credentials and built-in endpoints are
 * execution facts, not result semantics.  `openai-compatible` is the narrow
 * exception because its user-supplied endpoint selects the actual service.
 */
export type BookAnalysisRoutePlan = { version: 1; routes: Record<BookRouteSlot, BookRoutePlanEntry>; integrityHash?: string };

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("BOOK_ROUTE_PLAN_INVALID");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function normalizeEntry(entry: BookRoutePlanEntry): BookRoutePlanEntry {
  if (!entry.providerKey || !entry.protocol || !entry.modelId || !entry.connectionId || !entry.credentialVersionId || !entry.endpoint || !entry.adapterVersion || !/^[a-f0-9]{64}$/i.test(entry.configurationHash)) throw new Error("BOOK_ROUTE_PLAN_INVALID");
  return {
    providerKey: entry.providerKey,
    protocol: entry.protocol,
    modelId: entry.modelId,
    ...(entry.modelVersion ? { modelVersion: entry.modelVersion } : {}),
    configuration: JSON.parse(canonical(entry.configuration)) as Record<string, unknown>,
    configurationHash: entry.configurationHash,
    ...(entry.structuredOutput ? { structuredOutput: entry.structuredOutput } : {}),
    ...(entry.dimensions !== undefined ? { dimensions: entry.dimensions } : {}),
    connectionId: entry.connectionId,
    credentialVersionId: entry.credentialVersionId,
    endpoint: entry.endpoint,
    ...(entry.region ? { region: entry.region } : {}),
    adapterVersion: entry.adapterVersion,
  };
}

/**
 * A custom OpenAI-compatible endpoint is a provider-selected service identity.
 * Keep only the origin and path: credentials, query parameters, and fragments
 * must never become part of a durable semantic identity.
 */
function semanticCustomEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("BOOK_ROUTE_PLAN_INVALID");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}${pathname}`;
}

export function normalizeBookRoutePlan(plan: BookAnalysisRoutePlan): BookAnalysisRoutePlan {
  if (plan.version !== 1) throw new Error("BOOK_ROUTE_PLAN_VERSION_UNSUPPORTED");
  const routes = {} as Record<BookRouteSlot, BookRoutePlanEntry>;
  for (const slot of bookRouteSlots) {
    const entry = plan.routes?.[slot];
    if (!entry) throw new Error("BOOK_ROUTE_PLAN_INVALID");
    routes[slot] = normalizeEntry(entry);
  }
  if (!routes.EMBEDDING.dimensions || !Number.isSafeInteger(routes.EMBEDDING.dimensions) || routes.EMBEDDING.dimensions <= 0) throw new Error("BOOK_ROUTE_PLAN_INVALID");
  const normalized = { version: 1 as const, routes };
  const integrityHash = fullBookRoutePlanHash(normalized);
  if (plan.integrityHash !== undefined && plan.integrityHash !== integrityHash) throw new Error("BOOK_ROUTE_PLAN_INTEGRITY_FAILED");
  return { ...normalized, integrityHash };
}

function semanticPlan(plan: BookAnalysisRoutePlan) {
  const normalized = normalizeBookRoutePlan({ version: plan.version, routes: plan.routes });
  return {
    version: normalized.version,
    routes: Object.fromEntries(bookRouteSlots.map(routeSlot => {
      const entry = normalized.routes[routeSlot];
      return [routeSlot, {
        providerKey: entry.providerKey,
        protocol: entry.protocol,
        modelId: entry.modelId,
        ...(entry.modelVersion ? { modelVersion: entry.modelVersion } : {}),
        configuration: entry.configuration,
        configurationHash: entry.configurationHash,
        ...(entry.structuredOutput ? { structuredOutput: entry.structuredOutput } : {}),
        ...(entry.dimensions !== undefined ? { dimensions: entry.dimensions } : {}),
        ...(entry.providerKey === "openai-compatible" ? { executionTarget: semanticCustomEndpoint(entry.endpoint) } : {}),
      }];
    })),
  };
}

/** Stable result identity; adapter code is owned by pipelineVersion, not routes. */
export function bookRoutePlanHash(plan: BookAnalysisRoutePlan): string { return sha256(canonical(semanticPlan(plan))); }
/** Hash the full immutable execution plan, excluding only its self-referential seal. */
export function fullBookRoutePlanHash(plan: Pick<BookAnalysisRoutePlan, "version" | "routes">): string { return sha256(canonical({ version: plan.version, routes: normalizeRoutes(plan) })); }
function normalizeRoutes(plan: Pick<BookAnalysisRoutePlan, "version" | "routes">) {
  if (plan.version !== 1) throw new Error("BOOK_ROUTE_PLAN_VERSION_UNSUPPORTED");
  const routes = {} as Record<BookRouteSlot, BookRoutePlanEntry>;
  for (const slot of bookRouteSlots) {
    const entry = plan.routes?.[slot];
    if (!entry) throw new Error("BOOK_ROUTE_PLAN_INVALID");
    routes[slot] = normalizeEntry(entry);
  }
  if (!routes.EMBEDDING.dimensions || !Number.isSafeInteger(routes.EMBEDDING.dimensions) || routes.EMBEDDING.dimensions <= 0) throw new Error("BOOK_ROUTE_PLAN_INVALID");
  return routes;
}
export function canonicalBookRoutePlan(plan: BookAnalysisRoutePlan): string { return canonical(normalizeBookRoutePlan(plan)); }
