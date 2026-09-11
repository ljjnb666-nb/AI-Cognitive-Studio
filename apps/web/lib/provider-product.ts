import "server-only";

import { prisma } from "@ai-cognitive/db";
import { resolveProviderCatalog, routeSlotCapabilities, sanitizedProviderManifest, validateRouteManifestSelection, type RouteSlot } from "@ai-cognitive/provider-gateway";

const bookSlots = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"] as const;
const requiredSlots = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING", "PODCAST_SCRIPT", "PODCAST_TTS", "SHORT_VIDEO_SCRIPT", "SHORT_VIDEO_TTS", "THINKING_SESSION", "TEACH_BACK_ASSESSMENT"] as const;
type JsonRecord = Record<string, unknown>;
type RouteWithConnection = { routeSlot: string; modelId: string; configuration: unknown; connection: { id: string; providerKey: string; protocol: string; endpoint: string | null; status: string; credentialVersions: { id: string; status: string }[] } };
export type ProviderReadinessDependency = { slot: RouteSlot; label: string; state: "READY" | "MISSING"; providerKey?: string; providerName?: string; modelId?: string; error?: string };

export type ProductRouteIdentity = { provider: string; model: string; modelVersion?: string; configuration: JsonRecord };
export type PodcastVoice = { ordinal: number; providerVoiceId: string; voiceVersion: string; speakingRate: number; pitch: number; style?: string; language?: string; outputFormat: string };

export function productManifest() { return resolveProviderCatalog(process.env.PROVIDER_GATEWAY_MODEL_MANIFEST); }
export function safeConfiguration(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

export function assertSafeConfiguration(value: JsonRecord): void {
  const forbidden = /(^|[_-])(secret|token|password|api[_-]?key|credential|authorization)([_-]|$)/i;
  const visit = (item: unknown, path = "") => {
    if (Array.isArray(item)) return item.forEach((entry, index) => visit(entry, `${path}.${index}`));
    if (item && typeof item === "object") for (const [key, entry] of Object.entries(item)) {
      if (forbidden.test(key)) throw new Error("PROVIDER_CONFIGURATION_SECRET_FORBIDDEN");
      visit(entry, `${path}.${key}`);
    }
  };
  visit(value);
}

function modelVersion(configuration: JsonRecord): string | undefined { return typeof configuration.modelVersion === "string" && configuration.modelVersion.trim() ? configuration.modelVersion : undefined; }
function hasActiveCredential(route: RouteWithConnection): boolean { return route.connection.status === "ACTIVE" && route.connection.credentialVersions.some(item => item.status === "ACTIVE"); }
function hasExecutableEndpoint(endpoint: string | null): endpoint is string {
  if (!endpoint) return false;
  try { const url = new URL(endpoint); return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search; }
  catch { return false; }
}
async function routesForWorkspace(workspaceId: string): Promise<RouteWithConnection[]> {
  return prisma.providerRouteBinding.findMany({ where: { workspaceId }, include: { connection: { include: { credentialVersions: { where: { status: "ACTIVE" }, select: { id: true, status: true } } } } } }) as Promise<RouteWithConnection[]>;
}

function routeIdentity(manifest: ReturnType<typeof productManifest>, routes: RouteWithConnection[], routeSlot: RouteSlot): ProductRouteIdentity {
  const route = routes.find(item => item.routeSlot === routeSlot);
  if (!route || !hasActiveCredential(route) || !hasExecutableEndpoint(route.connection.endpoint)) throw new Error("AI_PROVIDER_CONFIGURATION_REQUIRED");
  const configuration = safeConfiguration(route.configuration);
  validateRouteManifestSelection(manifest, { routeSlot, providerKey: route.connection.providerKey, protocol: route.connection.protocol, modelId: route.modelId, configuration });
  return { provider: route.connection.providerKey, model: route.modelId, modelVersion: modelVersion(configuration), configuration };
}
const readinessDependencyLabels: Partial<Record<RouteSlot, string>> = {
  BOOK_CHUNK_ANALYSIS: "分块理解",
  BOOK_REDUCTION_ANALYSIS: "归并分析",
  BOOK_SYNTHESIS: "全书综合",
  EMBEDDING: "向量检索",
  THINKING_SESSION: "思考",
};
function readinessDependency(manifest: ReturnType<typeof productManifest>, routes: RouteWithConnection[], slot: RouteSlot, missingError?: string): ProviderReadinessDependency {
  try {
    const identity = routeIdentity(manifest, routes, slot), provider = manifest.providers.find(item => item.providerKey === identity.provider);
    return { slot, label: readinessDependencyLabels[slot] ?? slot, state: "READY", providerKey: identity.provider, providerName: provider?.displayName ?? identity.provider, modelId: identity.model };
  } catch (error) {
    return { slot, label: readinessDependencyLabels[slot] ?? slot, state: "MISSING", error: missingError ?? (error instanceof Error ? error.message : "AI_PROVIDER_CONFIGURATION_REQUIRED") };
  }
}

export async function resolveBookRouteIdentity(workspaceId: string): Promise<ProductRouteIdentity> {
  const manifest = productManifest(), routes = await routesForWorkspace(workspaceId);
  const identities = bookSlots.map(slot => routeIdentity(manifest, routes, slot));
  const [first] = identities;
  if (!first || identities.some(item => item.provider !== first.provider || item.model !== first.model || (item.modelVersion ?? "") !== (first.modelVersion ?? ""))) throw new Error("BOOK_ROUTE_IDENTITY_INCONSISTENT");
  return first;
}
export async function resolvePodcastRouteIdentity(workspaceId: string): Promise<ProductRouteIdentity> { return routeIdentity(productManifest(), await routesForWorkspace(workspaceId), "PODCAST_SCRIPT"); }
export async function resolveShortVideoRouteIdentity(workspaceId: string): Promise<ProductRouteIdentity> { return routeIdentity(productManifest(), await routesForWorkspace(workspaceId), "SHORT_VIDEO_SCRIPT"); }
export async function resolveThinkingSessionRouteIdentity(workspaceId: string): Promise<ProductRouteIdentity> { return routeIdentity(productManifest(), await routesForWorkspace(workspaceId), "THINKING_SESSION"); }
export async function resolveTeachBackAssessmentRouteIdentity(workspaceId: string): Promise<ProductRouteIdentity> { return routeIdentity(productManifest(), await routesForWorkspace(workspaceId), "TEACH_BACK_ASSESSMENT"); }
function configurationRequired(error: unknown): never {
  if (error instanceof Error && (error.message === "PODCAST_TTS_CONFIGURATION_REQUIRED" || error.message === "SHORT_VIDEO_TTS_VOICE_CONFIGURATION_REQUIRED")) throw error;
  throw new Error("AI_PROVIDER_CONFIGURATION_REQUIRED");
}
export async function resolveBookProductExecution(workspaceId: string): Promise<ProductRouteIdentity> {
  try { const routes = await routesForWorkspace(workspaceId), manifest = productManifest(); const identity = bookSlots.map(slot => routeIdentity(manifest, routes, slot)); const [first] = identity; if (!first || identity.some(item => item.provider !== first.provider || item.model !== first.model || (item.modelVersion ?? "") !== (first.modelVersion ?? ""))) throw new Error("BOOK_ROUTE_IDENTITY_INCONSISTENT"); routeIdentity(manifest, routes, "EMBEDDING"); return first; } catch (error) { return configurationRequired(error); }
}
export async function resolvePodcastProductExecution(workspaceId: string): Promise<ProductRouteIdentity> {
  try { const routes = await routesForWorkspace(workspaceId), manifest = productManifest(); const script = routeIdentity(manifest, routes, "PODCAST_SCRIPT"); routeIdentity(manifest, routes, "EMBEDDING"); return script; } catch (error) { return configurationRequired(error); }
}
export async function resolveShortVideoProductExecution(workspaceId: string): Promise<ProductRouteIdentity> {
  try { const routes = await routesForWorkspace(workspaceId), manifest = productManifest(); const script = routeIdentity(manifest, routes, "SHORT_VIDEO_SCRIPT"); routeIdentity(manifest, routes, "EMBEDDING"); const tts = routeIdentity(manifest, routes, "SHORT_VIDEO_TTS"); const configuration = tts.configuration; if (typeof configuration.providerVoiceId !== "string" || !configuration.providerVoiceId.trim() || typeof configuration.voiceVersion !== "string" || !configuration.voiceVersion.trim() || typeof configuration.outputFormat !== "string" || !configuration.outputFormat.trim() || !Number.isFinite(configuration.speakingRate) || !Number.isFinite(configuration.pitch)) throw new Error("SHORT_VIDEO_TTS_VOICE_CONFIGURATION_REQUIRED"); return script; } catch (error) { return configurationRequired(error); }
}
export async function resolveThinkingSessionProductExecution(workspaceId: string): Promise<ProductRouteIdentity> {
  try { return await resolveThinkingSessionRouteIdentity(workspaceId); } catch (error) { return configurationRequired(error); }
}
export async function resolveTeachBackProductExecution(workspaceId: string): Promise<ProductRouteIdentity> {
  try { return await resolveTeachBackAssessmentRouteIdentity(workspaceId); } catch (error) { return configurationRequired(error); }
}
export async function resolvePodcastAudioRoute(workspaceId: string): Promise<ProductRouteIdentity & { voices: PodcastVoice[] }> {
  const identity = routeIdentity(productManifest(), await routesForWorkspace(workspaceId), "PODCAST_TTS");
  const raw = identity.configuration.hostVoices;
  if (!Array.isArray(raw)) throw new Error("PODCAST_TTS_CONFIGURATION_REQUIRED");
  const voices = raw.map(item => item && typeof item === "object" ? item as PodcastVoice : undefined);
  if (!voices.length || voices.some(voice => !voice || !Number.isInteger(voice.ordinal) || !voice.providerVoiceId?.trim() || !voice.voiceVersion?.trim() || !Number.isFinite(voice.speakingRate) || !Number.isFinite(voice.pitch) || !voice.outputFormat?.trim())) throw new Error("PODCAST_TTS_CONFIGURATION_REQUIRED");
  return { ...identity, voices: voices as PodcastVoice[] };
}
export async function resolveShortVideoTtsRoute(workspaceId: string): Promise<ProductRouteIdentity> {
  const manifest = productManifest(), identity = routeIdentity(manifest, await routesForWorkspace(workspaceId), "SHORT_VIDEO_TTS");
  const configuration = identity.configuration;
  if (typeof configuration.providerVoiceId !== "string" || !configuration.providerVoiceId.trim() || typeof configuration.voiceVersion !== "string" || !configuration.voiceVersion.trim() || typeof configuration.outputFormat !== "string" || !configuration.outputFormat.trim() || !Number.isFinite(configuration.speakingRate) || !Number.isFinite(configuration.pitch)) throw new Error("SHORT_VIDEO_TTS_VOICE_CONFIGURATION_REQUIRED");
  return identity;
}

export async function providerReadiness(workspaceId: string) {
  const manifest = productManifest(), routes = await routesForWorkspace(workspaceId);
  const tryIdentity = (slot: RouteSlot) => { try { routeIdentity(manifest, routes, slot); return undefined; } catch (error) { return error instanceof Error ? error.message : "AI_PROVIDER_CONFIGURATION_REQUIRED"; } };
  const missing = (slots: readonly RouteSlot[]) => slots.map(tryIdentity).filter((item): item is string => Boolean(item));
  // Text and embeddings are independent Book Intelligence dependencies.  Do
  // not report a text-complete workspace as ready merely because its embedding
  // route is absent or unusable.
  const bookDependencies = (["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING"] as const).map(slot => readinessDependency(manifest, routes, slot, slot === "EMBEDDING" ? "BOOK_EMBEDDING_PROVIDER_NOT_CONFIGURED" : undefined));
  const bookMissing = bookDependencies.flatMap(item => item.state === "MISSING" ? [item.error ?? "AI_PROVIDER_CONFIGURATION_REQUIRED"] : []);
  try { await resolveBookRouteIdentity(workspaceId); } catch (error) { bookMissing.push(error instanceof Error ? error.message : "BOOK_ROUTE_IDENTITY_INCONSISTENT"); }
  const podcastMissing = missing(["PODCAST_SCRIPT", "EMBEDDING"]);
  const audioMissing = missing(["PODCAST_TTS"]);
  try { await resolvePodcastAudioRoute(workspaceId); } catch (error) { audioMissing.push(error instanceof Error ? error.message : "PODCAST_TTS_CONFIGURATION_REQUIRED"); }
  const videoMissing = missing(["SHORT_VIDEO_SCRIPT", "EMBEDDING", "SHORT_VIDEO_TTS"]);
  const thinkingDependency = readinessDependency(manifest, routes, "THINKING_SESSION");
  const thinkingMissing = thinkingDependency.state === "MISSING" ? [thinkingDependency.error ?? "AI_PROVIDER_CONFIGURATION_REQUIRED"] : [];
  const masteryMissing = missing(["TEACH_BACK_ASSESSMENT"]);
  try { await resolveShortVideoTtsRoute(workspaceId); } catch (error) { videoMissing.push(error instanceof Error ? error.message : "SHORT_VIDEO_TTS_VOICE_CONFIGURATION_REQUIRED"); }
  const bookConfigured = bookDependencies.filter(item => item.state === "READY").length;
  return { book: { state: bookMissing.length ? "INCOMPLETE" : "READY", missing: [...new Set(bookMissing)], configured: bookConfigured, required: bookDependencies.length, dependencies: bookDependencies }, podcast: { state: podcastMissing.length ? "INCOMPLETE" : "READY", missing: [...new Set(podcastMissing)] }, podcastAudio: { state: audioMissing.length ? "INCOMPLETE" : "READY", missing: [...new Set(audioMissing)] }, shortVideo: { state: videoMissing.length ? "INCOMPLETE" : "READY", missing: [...new Set(videoMissing)] }, thinking: { state: thinkingMissing.length ? "INCOMPLETE" : "READY", missing: [...new Set(thinkingMissing)], dependencies: [thinkingDependency] }, mastery: { state: masteryMissing.length ? "INCOMPLETE" : "READY", missing: [...new Set(masteryMissing)] } } as const;
}

export function routeCapability(routeSlot: RouteSlot) { return routeSlotCapabilities[routeSlot]; }
export { requiredSlots };
