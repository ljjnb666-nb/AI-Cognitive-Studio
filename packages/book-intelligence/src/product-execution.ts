import { prisma } from "@ai-cognitive/db";
import { resolveProviderCatalog, stableHash, validateRouteManifestSelection } from "@ai-cognitive/provider-gateway";
import { normalizeBookRoutePlan, type BookAnalysisRoutePlan } from "./route-plan.js";

const slots = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING"] as const;
type Route = { routeSlot: string; modelId: string; configuration: unknown; connection: { id: string; providerKey: string; protocol: string; endpoint: string | null; status: string; credentialVersions: { id: string; status: string }[] } };
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const endpoint = (value: string | null): value is string => { try { const url = new URL(value ?? ""); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } };

/** Shared, pinned Book route-plan builder for Web requests and durable Workers. */
export async function resolveBookProductExecution(workspaceId: string): Promise<{ provider: string; model: string; modelVersion?: string; configuration: Record<string, unknown>; routePlan: BookAnalysisRoutePlan }> {
  const manifest = resolveProviderCatalog(process.env.PROVIDER_GATEWAY_MODEL_MANIFEST);
  const routes = await prisma.providerRouteBinding.findMany({ where: { workspaceId }, include: { connection: { include: { credentialVersions: { where: { status: "ACTIVE" }, select: { id: true, status: true } } } } } }) as Route[];
  const entries = {} as BookAnalysisRoutePlan["routes"];
  try {
    for (const routeSlot of slots) {
      const route = routes.find(item => item.routeSlot === routeSlot);
      if (!route || route.connection.status !== "ACTIVE" || !endpoint(route.connection.endpoint)) throw new Error("AI_PROVIDER_CONFIGURATION_REQUIRED");
      const credential = route.connection.credentialVersions[0], configuration = record(route.configuration);
      if (!credential) throw new Error("AI_PROVIDER_CONFIGURATION_REQUIRED");
      validateRouteManifestSelection(manifest, { routeSlot, providerKey: route.connection.providerKey, protocol: route.connection.protocol, modelId: route.modelId, configuration });
      const provider = manifest.providers.find(item => item.providerKey === route.connection.providerKey);
      const model = provider?.models.find(item => item.modelId === route.modelId);
      if (!provider || !model) throw new Error("AI_PROVIDER_CONFIGURATION_REQUIRED");
      const dimensions = routeSlot === "EMBEDDING" ? Number(configuration.embeddingDimensions ?? model?.embeddingDimensions) : undefined;
      if (routeSlot === "EMBEDDING" && (!Number.isSafeInteger(dimensions) || dimensions! <= 0)) throw new Error("BOOK_EMBEDDING_PROVIDER_NOT_CONFIGURED");
      entries[routeSlot] = { providerKey: route.connection.providerKey, protocol: route.connection.protocol, modelId: route.modelId, ...(typeof configuration.modelVersion === "string" && configuration.modelVersion ? { modelVersion: configuration.modelVersion } : {}), configuration, configurationHash: stableHash(configuration), connectionId: route.connection.id, credentialVersionId: credential.id, endpoint: route.connection.endpoint, adapterVersion: provider.adapterVersion, ...(routeSlot === "EMBEDDING" ? { dimensions } : { structuredOutput: model.structuredOutput === "STRICT_JSON_SCHEMA" ? "STRICT_JSON_SCHEMA" : "JSON_MODE" }) };
    }
    const routePlan = normalizeBookRoutePlan({ version: 1, routes: entries });
    const chunk = routePlan.routes.BOOK_CHUNK_ANALYSIS;
    return { provider: chunk.providerKey, model: chunk.modelId, modelVersion: chunk.modelVersion, configuration: chunk.configuration, routePlan };
  } catch (error) { if (error instanceof Error && ["AI_PROVIDER_CONFIGURATION_REQUIRED", "BOOK_EMBEDDING_PROVIDER_NOT_CONFIGURED"].includes(error.message)) throw error; throw new Error("AI_PROVIDER_CONFIGURATION_REQUIRED"); }
}
