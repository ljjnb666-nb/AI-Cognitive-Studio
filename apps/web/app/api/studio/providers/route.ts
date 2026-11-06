import { readEnvironment } from "@ai-cognitive/shared/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ProviderGatewayRepository, managedConnectionParent, builtInProviderProfiles, builtInProviderTestEndpoint, resolveCredentialKeyring, sanitizedProviderManifest, validateRouteManifestSelection, validateProviderEndpoint, routeSlotCapabilities, type RouteSlot } from "@ai-cognitive/provider-gateway";
import { prisma } from "@ai-cognitive/db";
import { resolveWebIdentity } from "@/lib/identity";
import { assertSafeConfiguration, productManifest, providerReadiness, safeConfiguration } from "@/lib/provider-product";
import { providerSettingsFailure } from "@/lib/provider-settings-errors";
import { miniMaxTestEndpoint, validMiniMaxModelList } from "@/lib/minimax-endpoints";

const jsonRecord = z.record(z.string(), z.unknown()).default({});
const executableEndpoint = z.string().url().max(500).refine(value => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search; } catch { return false; } }, "PROVIDER_CONNECTION_ENDPOINT_INVALID");
const createConnection = z.object({ action: z.literal("CREATE_CONNECTION"), providerKey: z.string().trim().min(1).max(80), protocol: z.string().trim().min(1).max(80), displayName: z.string().trim().min(1).max(160), endpoint: executableEndpoint, region: z.string().trim().min(1).max(80).optional(), configuration: jsonRecord });
const createConnectionWithCredential = z.object({ action: z.literal("CREATE_CONNECTION_WITH_CREDENTIAL"), providerKey: z.string().trim().min(1).max(80), protocol: z.string().trim().min(1).max(80), displayName: z.string().trim().min(1).max(160), endpoint: executableEndpoint, secret: z.string().trim().min(1).max(10_000), region: z.string().trim().min(1).max(80).optional(), configuration: jsonRecord });
const setCredential = z.object({ action: z.literal("SET_CREDENTIAL"), connectionId: z.string().cuid(), secret: z.string().trim().min(1).max(10_000) });
const revokeCredential = z.object({ action: z.literal("REVOKE_CREDENTIAL"), credentialVersionId: z.string().uuid() });
const deleteConnection = z.object({ action: z.literal("DELETE_CONNECTION"), connectionId: z.string().cuid(), expectedRouteSlots: z.array(z.string().max(100)).max(32), expectedCredentialVersionId: z.string().uuid().nullable() });
const setEnabled = z.object({ action: z.literal("SET_ENABLED"), connectionId: z.string().cuid(), enabled: z.boolean() });
const setRoute = z.object({ applyToBookStages: z.boolean().optional(), action: z.literal("SET_ROUTE"), routeSlot: z.enum(["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING", "PODCAST_SCRIPT", "PODCAST_TTS", "SHORT_VIDEO_SCRIPT", "SHORT_VIDEO_TTS", "THINKING_SESSION", "TEACH_BACK_ASSESSMENT", "PDF_VISUAL_STRUCTURE"]), connectionId: z.string().cuid(), modelId: z.string().trim().min(1).max(200), configuration: jsonRecord });
const testConnection = z.object({ action: z.literal("TEST_CONNECTION"), providerKey: z.string().trim().min(1).max(80), protocol: z.string().trim().min(1).max(80), endpoint: executableEndpoint, secret: z.string().trim().min(1).max(10_000), configuration: jsonRecord });
const autoConfigureRoutes = z.object({ action: z.literal("AUTO_CONFIGURE_ROUTES"), connectionId: z.string().cuid(), modelId: z.string().trim().min(1).max(200).optional() });
const stableBookRoutesInput = z.object({ action: z.literal("APPLY_STABLE_BOOK_ROUTES"), textConnectionId: z.string().cuid(), textModelId: z.string().trim().min(1).max(200), textConfiguration: jsonRecord, embeddingConnectionId: z.string().cuid(), embeddingModelId: z.string().trim().min(1).max(200), embeddingConfiguration: jsonRecord });
const bodySchema = z.discriminatedUnion("action", [deleteConnection, createConnection, createConnectionWithCredential, setCredential, revokeCredential, setEnabled, setRoute, testConnection, autoConfigureRoutes, stableBookRoutesInput]);

function safeConnection(connection: { id: string; providerKey: string; protocol: string; displayName: string; endpoint: string | null; region: string | null; status: string; health: string; credentialVersions: { id: string; displayHint: string | null; status: string }[] }) {
  const credential = connection.credentialVersions[0];
  return { id: connection.id, providerKey: connection.providerKey, protocol: connection.protocol, displayName: connection.displayName, endpoint: connection.endpoint, region: connection.region, status: connection.status, health: connection.health, credential: credential ? { id: credential.id, exists: true, displayHint: credential.displayHint, status: credential.status } : { exists: false } };
}
async function response(workspaceId: string) {
  const [connections, routes, readiness] = await Promise.all([
    prisma.providerConnection.findMany({ where: { workspaceId, status: { not: "REVOKED" } }, include: { credentialVersions: { where: { status: { in: ["ACTIVE", "RETIRED"] } }, orderBy: { credentialVersion: "desc" }, take: 1, select: { id: true, displayHint: true, status: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.providerRouteBinding.findMany({ where: { workspaceId }, include: { connection: { select: { id: true, displayName: true, providerKey: true, protocol: true, status: true } } }, orderBy: { routeSlot: "asc" } }),
    providerReadiness(workspaceId),
  ]);
  const parentById = new Map(connections.map(connection => [connection.id, managedConnectionParent(connection, connections)]));
  const visible = connections.filter(connection => !parentById.get(connection.id));
  const manifest = productManifest();
  // Use the same capability gate for displayed choices and saved bindings.
  const routeModels = Object.fromEntries(visible.map(connection => {
    const provider = manifest.providers.find(item => item.providerKey === connection.providerKey);
    return [connection.id, Object.fromEntries((Object.keys(routeSlotCapabilities) as RouteSlot[]).map(routeSlot => [routeSlot, (provider?.models ?? []).filter(model => {
      if (model.deprecated || model.retired) return false;
      try { validateRouteManifestSelection(manifest, { routeSlot, providerKey: connection.providerKey, protocol: provider?.capabilityProtocols?.[routeSlotCapabilities[routeSlot]] ?? provider!.protocol, modelId: model.modelId }); return true; }
      catch { return false; }
    })]))];
  }));
  return NextResponse.json({ manifest: sanitizedProviderManifest(manifest), routeModels, connections: visible.map(connection => ({ ...safeConnection(connection), managedCapabilities: connections.filter(child => parentById.get(child.id)?.id === connection.id).map(child => child.protocol === "CUSTOM_SPEECH" ? "语音合成" : "向量检索") })), routes: routes.map(route => {
    const parent = parentById.get(route.connectionId);
    return { id: route.id, routeSlot: route.routeSlot, connectionId: parent?.id ?? route.connectionId, modelId: route.modelId, configuration: safeConfiguration(route.configuration), connection: parent ? { id:parent.id,displayName:parent.displayName,providerKey:parent.providerKey,protocol:parent.protocol,status:parent.status } : route.connection };
  }), readiness });
}
async function resolveProviderHostname(hostname: string): Promise<readonly string[]> {
  // The Phase 9 browser harness deliberately uses this non-routable namespace;
  // keep the production resolver and SSRF policy unchanged for every real host.
  if (readEnvironment().NODE_ENV === "test" && process.env.PHASE9_BULLMQ_PREFIX && hostname.endsWith(".example.test")) return ["93.184.216.34"];
  return (await (await import("node:dns/promises")).lookup(hostname, { all: true })).map(item => item.address);
}
function connectionTestUrl(input: z.infer<typeof testConnection>): string | undefined {
  if (input.providerKey === "qwen") {
    assertQwenConnectionConfiguration(input.providerKey, input.endpoint, input.configuration);
    const url = new URL(qwenEndpoint(input.configuration));
    url.pathname = "/api/v1/models";
    return url.toString();
  }
  return input.providerKey === "minimax" ? miniMaxTestEndpoint(input.endpoint) : builtInProviderTestEndpoint(input.providerKey);
}
function assertFixedMiniMaxEndpoint(providerKey: string, endpoint: string) {
  if (providerKey !== "minimax") return;
  if (!miniMaxTestEndpoint(endpoint)) throw new Error("PROVIDER_CONNECTION_ENDPOINT_INVALID");
}
function qwenEndpoint(configuration: Record<string, unknown>): string {
  const region = configuration.qwenRegion, workspaceId = configuration.qwenWorkspaceId;
  if ((region !== "BEIJING" && region !== "SINGAPORE") || typeof workspaceId !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workspaceId)) throw new Error("QWEN_CONFIGURATION_INVALID");
  return `https://${workspaceId}.${region === "BEIJING" ? "cn-beijing" : "ap-southeast-1"}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`;
}
function assertQwenConnectionConfiguration(providerKey: string, endpoint: string, configuration: Record<string, unknown>) {
  if (providerKey === "qwen" && endpoint !== qwenEndpoint(configuration)) throw new Error("PROVIDER_CONNECTION_ENDPOINT_INVALID");
}
function assertQwenRouteConfiguration(providerKey: string, routeSlot: RouteSlot, configuration: Record<string, unknown>) {
  if (providerKey !== "qwen") return;
  qwenEndpoint(configuration);
  if (routeSlot === "EMBEDDING") {
    const dimension = configuration.embeddingDimensions;
    if (typeof dimension !== "number" || ![2048, 1536, 1024, 768, 512, 256, 128, 64].includes(dimension)) throw new Error("QWEN_CONFIGURATION_INVALID");
  }
}
function inheritedRouteConfiguration(connection: { providerKey: string; endpoint: string | null; configuration: unknown }, configuration: Record<string, unknown>): Record<string, unknown> {
  if (connection.providerKey !== "qwen") return configuration;
  const saved = safeConfiguration(connection.configuration);
  assertQwenConnectionConfiguration(connection.providerKey, connection.endpoint ?? "", saved);
  return { ...configuration, qwenRegion: saved.qwenRegion, qwenWorkspaceId: saved.qwenWorkspaceId };
}
async function testSubmittedConnection(input: z.infer<typeof testConnection>, manifest: ReturnType<typeof productManifest>) {
  const provider = manifest.providers.find(item => item.providerKey === input.providerKey);
  if (!provider || ![provider.protocol, ...Object.values(provider.capabilityProtocols ?? {})].includes(input.protocol as never)) throw new Error("PROVIDER_CONNECTION_PROTOCOL_INVALID");
  assertFixedMiniMaxEndpoint(input.providerKey, input.endpoint);
  await validateProviderEndpoint(input.endpoint, { environment: process.env.NODE_ENV ?? "production", allowPrivateEndpoints: process.env.ALLOW_PRIVATE_PROVIDER_ENDPOINTS === "true", dns: { lookup: resolveProviderHostname } });
  const url = connectionTestUrl(input); if (!url) return { state: "UNSUPPORTED_TEST" as const };
  // The isolated development release harness replaces only the remote HTTP boundary.
  if (process.env.NODE_ENV !== "production" && process.env.BETA_PROVIDER_UX_TEST_CONNECTION_TRANSPORT === "deterministic") return { state: "VALID" as const };
  const headers: Record<string, string> = input.providerKey === "anthropic" ? { "x-api-key": input.secret, "anthropic-version": "2023-06-01" } : input.providerKey === "gemini" ? { "x-goog-api-key": input.secret } : { authorization: `Bearer ${input.secret}` };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5_000);
  try { const result = await fetch(url, { method: "GET", headers, signal: controller.signal, redirect: "error" }); if (result.status === 401 || result.status === 403) return { state: "AUTHENTICATION_FAILED" as const }; if (!result.ok) return { state: "PROVIDER_REJECTED" as const };
    if (input.providerKey === "minimax" && !validMiniMaxModelList(await result.json().catch(() => null))) return { state: "INVALID_TEST_RESPONSE" as const };
    if (input.providerKey === "qwen") {
      const body = await result.json().catch(() => null);
      if (body?.success !== true || !Array.isArray(body?.output?.models) || !body.output.models.every((model: unknown) => model && typeof model === "object" && "model" in model && typeof model.model === "string" && model.model.length > 0)) return { state: "INVALID_TEST_RESPONSE" as const };
    }
    return { state: "VALID" as const }; }
  catch (error) { return { state: error instanceof DOMException && error.name === "AbortError" ? "TIMEOUT" as const : "ENDPOINT_UNREACHABLE" as const }; }
  finally { clearTimeout(timer); }
}
const textSlots: RouteSlot[] = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "PODCAST_SCRIPT", "SHORT_VIDEO_SCRIPT", "THINKING_SESSION"];
async function autoConfigure(context: { workspaceId: string; userId: string }, input: z.infer<typeof autoConfigureRoutes>, manifest: ReturnType<typeof productManifest>, repository: ProviderGatewayRepository, cipher: NonNullable<ReturnType<typeof resolveCredentialKeyring>>) {
  const connection = await prisma.providerConnection.findUnique({ where: { id_workspaceId: { id: input.connectionId, workspaceId: context.workspaceId } } });
  if (!connection) throw new Error("AUTHORIZATION_FAILED");
  const provider = manifest.providers.find(item => item.providerKey === connection.providerKey); if (!provider) throw new Error("PROVIDER_CONNECTION_PROTOCOL_INVALID");
  const chosen = input.modelId ? provider.models.find(model => model.modelId === input.modelId) : provider.models.find(model => model.families.includes("TEXT_GENERATION"));
  // An embedding-only catalog entry is still useful: it can fill EMBEDDING
  // without pretending that it offers a text-generation route.
  if (input.modelId && !chosen) throw new Error("CAPABILITY_MISMATCH");
  const bound: string[] = [], skipped: string[] = [];
  const existingBindings = new Set((await prisma.providerRouteBinding.findMany({ where: { workspaceId: context.workspaceId }, select: { routeSlot: true } })).map(route => route.routeSlot));
  const credential = await prisma.providerCredentialVersion.findFirst({ where: { workspaceId: context.workspaceId, connectionId: connection.id, status: "ACTIVE" }, orderBy: { credentialVersion: "desc" } });
  if (!credential) throw new Error("AUTHORIZATION_FAILED");
  const secret = cipher.decrypt(credential, { workspaceId: context.workspaceId, connectionId: connection.id, credentialVersionId: credential.id, providerKey: connection.providerKey });
  const connectionFor = async (family: "TEXT_GENERATION" | "EMBEDDING" | "SPEECH") => {
    const protocol = provider.capabilityProtocols?.[family] ?? provider.protocol;
    if (connection.protocol === protocol) return connection;
    const existing = await prisma.providerConnection.findFirst({ where: { workspaceId: context.workspaceId, providerKey: connection.providerKey, protocol, status: "ACTIVE", credentialVersions: { some: { status: "ACTIVE" } } }, orderBy: { createdAt: "asc" } });
    if (existing) return existing;
    const endpoint = builtInProviderProfiles.find(profile => profile.providerKey === connection.providerKey && profile.family === family && profile.protocol === protocol)?.endpoint;
    if (!endpoint) throw new Error("CAPABILITY_MISMATCH");
    return (await repository.createConnectionWithCredential(context, { providerKey: connection.providerKey, protocol, displayName: `${provider.displayName}（${family === "TEXT_GENERATION" ? "文本" : family === "EMBEDDING" ? "向量" : "语音"}）`, endpoint, secret, configuration: {} })).connection;
  };
  const bindIfUnbound = async (routeSlot: RouteSlot, connectionId: string, protocol: string, modelId: string, configuration: Record<string, unknown> = {}) => {
    if (existingBindings.has(routeSlot)) { skipped.push(routeSlot); return; }
    try { validateRouteManifestSelection(manifest, { routeSlot, providerKey: connection.providerKey, protocol, modelId, configuration }); await repository.setRoute(context, { routeSlot, connectionId, modelId, configuration }); bound.push(routeSlot); }
    catch { skipped.push(routeSlot); }
  };
  const qwenConfiguration = safeConfiguration(connection.configuration);
  if (chosen?.families.includes("TEXT_GENERATION")) { const textConnection = await connectionFor("TEXT_GENERATION"); for (const routeSlot of textSlots) await bindIfUnbound(routeSlot, textConnection.id, textConnection.protocol, chosen.modelId, textConnection.providerKey === "qwen" ? qwenConfiguration : {});
    if (chosen.structuredOutput === "STRICT_JSON_SCHEMA") await bindIfUnbound("TEACH_BACK_ASSESSMENT", textConnection.id, textConnection.protocol, chosen.modelId, textConnection.providerKey === "qwen" ? qwenConfiguration : {}); }
  const embedding = provider.models.find(model => model.families.includes("EMBEDDING"));
  if (embedding) { try { const embeddingConnection = await connectionFor("EMBEDDING"); const configuration = embeddingConnection.providerKey === "qwen" ? { ...qwenConfiguration, embeddingDimensions: embedding.embeddingDimensions } : {}; await bindIfUnbound("EMBEDDING", embeddingConnection.id, embeddingConnection.protocol, embedding.modelId, configuration); } catch { skipped.push("EMBEDDING"); } }
  // Speech needs user-approved voice metadata and is therefore never auto-bound merely because a key is valid.
  for (const routeSlot of ["PODCAST_TTS", "SHORT_VIDEO_TTS"] as const) skipped.push(routeSlot);
  return { bound, skipped };
}
async function applyStableBookRoutes(context: { workspaceId: string; userId: string }, input: z.infer<typeof stableBookRoutesInput>, manifest: ReturnType<typeof productManifest>, repository: ProviderGatewayRepository) {
  const [text, embedding] = await Promise.all([prisma.providerConnection.findUnique({ where: { id_workspaceId: { id: input.textConnectionId, workspaceId: context.workspaceId } } }), prisma.providerConnection.findUnique({ where: { id_workspaceId: { id: input.embeddingConnectionId, workspaceId: context.workspaceId } } })]);
  if (!text || !embedding) throw new Error("AUTHORIZATION_FAILED");
  input = { ...input, textConfiguration: inheritedRouteConfiguration(text, input.textConfiguration), embeddingConfiguration: inheritedRouteConfiguration(embedding, input.embeddingConfiguration) };
  assertSafeConfiguration(input.textConfiguration); assertSafeConfiguration(input.embeddingConfiguration);
  assertQwenRouteConfiguration(text.providerKey, "BOOK_CHUNK_ANALYSIS", input.textConfiguration); assertQwenRouteConfiguration(embedding.providerKey, "EMBEDDING", input.embeddingConfiguration);
  const textRoutes = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"] as const;
  // Validate the complete command before the repository receives any mutation.
  for (const routeSlot of textRoutes) validateRouteManifestSelection(manifest, { routeSlot, providerKey: text.providerKey, protocol: text.protocol, modelId: input.textModelId, configuration: input.textConfiguration });
  validateRouteManifestSelection(manifest, { routeSlot: "EMBEDDING", providerKey: embedding.providerKey, protocol: embedding.protocol, modelId: input.embeddingModelId, configuration: input.embeddingConfiguration });
  await repository.setRoutesAtomically(context, [...textRoutes.map(routeSlot => ({ routeSlot, connectionId: text.id, modelId: input.textModelId, configuration: input.textConfiguration })), { routeSlot: "EMBEDDING", connectionId: embedding.id, modelId: input.embeddingModelId, configuration: input.embeddingConfiguration }]);
}
function failure(error: unknown) { const result = providerSettingsFailure(error); return NextResponse.json({ error: result.code }, { status: result.status }); }

export async function GET() {
  try { return await response((await resolveWebIdentity()).workspaceId); } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const context = await resolveWebIdentity(), parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message === "PROVIDER_CONNECTION_ENDPOINT_INVALID" ? "PROVIDER_CONNECTION_ENDPOINT_INVALID" : "PROVIDER_SETTINGS_REQUEST_FAILED");
    const input = parsed.data;
    const membership = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: context.workspaceId, userId: context.userId } }, select: { role: true } });
    if (membership?.role !== "OWNER") throw new Error("AUTHORIZATION_FAILED");
    const manifest = productManifest();
    if (input.action === "TEST_CONNECTION") return NextResponse.json({ test: await testSubmittedConnection(input, manifest) });
    const cipher = resolveCredentialKeyring(process.env, { initializeLocal: input.action === "CREATE_CONNECTION_WITH_CREDENTIAL" || input.action === "SET_CREDENTIAL" });
    if (!cipher && ["CREATE_CONNECTION_WITH_CREDENTIAL", "SET_CREDENTIAL", "AUTO_CONFIGURE_ROUTES"].includes(input.action)) throw new Error("PROVIDER_GATEWAY_KEYRING_MISSING");
    const repository = new ProviderGatewayRepository(prisma, cipher);
    if (input.action === "AUTO_CONFIGURE_ROUTES") { const configured = await autoConfigure(context, input, manifest, repository, cipher!); return NextResponse.json({ ...(await (await response(context.workspaceId)).json()), autoConfigure: configured }); }
    if (input.action === "APPLY_STABLE_BOOK_ROUTES") { await applyStableBookRoutes(context, input, manifest, repository); return response(context.workspaceId); }
    if (input.action === "CREATE_CONNECTION" || input.action === "CREATE_CONNECTION_WITH_CREDENTIAL") {
      assertSafeConfiguration(input.configuration);
      assertFixedMiniMaxEndpoint(input.providerKey, input.endpoint);
      assertQwenConnectionConfiguration(input.providerKey, input.endpoint, input.configuration);
      await validateProviderEndpoint(input.endpoint, { environment: process.env.NODE_ENV ?? "production", allowPrivateEndpoints: process.env.ALLOW_PRIVATE_PROVIDER_ENDPOINTS === "true", dns: { lookup: resolveProviderHostname } });
      const provider = manifest.providers.find(item => item.providerKey === input.providerKey);
      if (!provider || ![provider.protocol, ...Object.values(provider.capabilityProtocols ?? {})].includes(input.protocol as never)) throw new Error("PROVIDER_CONNECTION_PROTOCOL_INVALID");
      if (input.action === "CREATE_CONNECTION_WITH_CREDENTIAL") await repository.createConnectionWithCredential(context, input);
      else await repository.createConnection(context, input);
    } else if (input.action === "SET_CREDENTIAL") {
      await repository.manageProvider(context, input.connectionId, { action: "ROTATE", secret: input.secret });
    } else if (input.action === "REVOKE_CREDENTIAL") {
      const credential = await prisma.providerCredentialVersion.findUnique({ where: { id_workspaceId: { id: input.credentialVersionId, workspaceId: context.workspaceId } }, select: { connectionId:true } });
      if (!credential) throw new Error("AUTHORIZATION_FAILED");
      await repository.manageProvider(context, credential.connectionId, { action: "REVOKE", credentialVersionId: input.credentialVersionId });
    } else if (input.action === "DELETE_CONNECTION") {
      await repository.manageProvider(context, input.connectionId, { action:"DELETE", routeSlots: input.expectedRouteSlots, credentialVersionId: input.expectedCredentialVersionId });
    } else if (input.action === "SET_ENABLED") {
      await repository.manageProvider(context, input.connectionId, { action:"ENABLED",enabled:input.enabled });
    } else {
      assertSafeConfiguration(input.configuration);
      const connection = await prisma.providerConnection.findUnique({ where: { id_workspaceId: { id: input.connectionId, workspaceId: context.workspaceId } }, select: { id: true, providerKey: true, protocol: true, status: true, endpoint: true, configuration: true } });
      if (!connection) throw new Error("AUTHORIZATION_FAILED");
      if (connection.status !== "ACTIVE") throw new Error("CONNECTION_DISABLED");
      input.configuration = inheritedRouteConfiguration(connection, input.configuration);
      const provider = manifest.providers.find(item => item.providerKey === connection.providerKey);
      const family = input.routeSlot === "EMBEDDING" ? "EMBEDDING" : input.routeSlot.endsWith("TTS") ? "SPEECH" : "TEXT_GENERATION";
      const protocol = provider?.capabilityProtocols?.[family] ?? provider?.protocol;
      // Validate before creating a capability-specific connection. Only built-in endpoints are eligible.
      validateRouteManifestSelection(manifest, { routeSlot: input.routeSlot as RouteSlot, providerKey: connection.providerKey, protocol: protocol ?? connection.protocol, modelId: input.modelId, configuration: input.configuration });
      let targetConnection = connection;
      if (protocol && protocol !== connection.protocol) {
        const endpoint = builtInProviderProfiles.find(profile => profile.providerKey === connection.providerKey && profile.family === family && profile.protocol === protocol)?.endpoint;
        if (!endpoint) throw new Error("CAPABILITY_MISMATCH");
        if (!cipher) throw new Error("PROVIDER_GATEWAY_KEYRING_MISSING");
        targetConnection = await repository.capabilityConnection(context, connection.id, { family:family as "SPEECH" | "EMBEDDING", protocol, endpoint, displayName: `${provider!.displayName}（${family === "SPEECH" ? "语音" : "向量"} ${connection.id}）` });
      }
      assertQwenRouteConfiguration(connection.providerKey, input.routeSlot as RouteSlot, input.configuration);
      validateRouteManifestSelection(manifest, { routeSlot: input.routeSlot as RouteSlot, providerKey: connection.providerKey, protocol: targetConnection.protocol, modelId: input.modelId, configuration: input.configuration });
      const slots: RouteSlot[] = input.applyToBookStages && input.routeSlot === "BOOK_CHUNK_ANALYSIS" ? ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS"] : [input.routeSlot as RouteSlot];
      for (const routeSlot of slots) validateRouteManifestSelection(manifest, { routeSlot, providerKey: connection.providerKey, protocol: targetConnection.protocol, modelId: input.modelId, configuration: input.configuration });
      await repository.setRoutesAtomically(context, slots.map(routeSlot => ({ ...input, routeSlot, connectionId: targetConnection.id })));
    }
    return response(context.workspaceId);
  } catch (error) { return failure(error); }
}
