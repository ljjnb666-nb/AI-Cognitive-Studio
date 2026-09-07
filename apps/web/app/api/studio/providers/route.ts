import { NextResponse } from "next/server";
import { z } from "zod";
import { ProviderGatewayError, ProviderGatewayRepository, resolveCredentialKeyring, sanitizedProviderManifest, validateRouteManifestSelection, validateProviderEndpoint, type RouteSlot } from "@ai-cognitive/provider-gateway";
import { prisma } from "@ai-cognitive/db";
import { resolveWebIdentity } from "@/lib/identity";
import { assertSafeConfiguration, productManifest, providerReadiness, safeConfiguration } from "@/lib/provider-product";

const jsonRecord = z.record(z.string(), z.unknown()).default({});
const executableEndpoint = z.string().url().max(500).refine(value => { try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search; } catch { return false; } }, "PROVIDER_CONNECTION_ENDPOINT_INVALID");
const createConnection = z.object({ action: z.literal("CREATE_CONNECTION"), providerKey: z.string().trim().min(1).max(80), protocol: z.string().trim().min(1).max(80), displayName: z.string().trim().min(1).max(160), endpoint: executableEndpoint, region: z.string().trim().min(1).max(80).optional(), configuration: jsonRecord });
const createConnectionWithCredential = z.object({ action: z.literal("CREATE_CONNECTION_WITH_CREDENTIAL"), providerKey: z.string().trim().min(1).max(80), protocol: z.string().trim().min(1).max(80), displayName: z.string().trim().min(1).max(160), endpoint: executableEndpoint, secret: z.string().trim().min(1).max(10_000), region: z.string().trim().min(1).max(80).optional(), configuration: jsonRecord });
const setCredential = z.object({ action: z.literal("SET_CREDENTIAL"), connectionId: z.string().cuid(), secret: z.string().trim().min(1).max(10_000) });
const revokeCredential = z.object({ action: z.literal("REVOKE_CREDENTIAL"), credentialVersionId: z.string().uuid() });
const setEnabled = z.object({ action: z.literal("SET_ENABLED"), connectionId: z.string().cuid(), enabled: z.boolean() });
const setRoute = z.object({ action: z.literal("SET_ROUTE"), routeSlot: z.enum(["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING", "PODCAST_SCRIPT", "PODCAST_TTS", "SHORT_VIDEO_SCRIPT", "SHORT_VIDEO_TTS", "THINKING_SESSION", "TEACH_BACK_ASSESSMENT"]), connectionId: z.string().cuid(), modelId: z.string().trim().min(1).max(200), configuration: jsonRecord });
const testConnection = z.object({ action: z.literal("TEST_CONNECTION"), providerKey: z.string().trim().min(1).max(80), protocol: z.string().trim().min(1).max(80), endpoint: executableEndpoint, secret: z.string().trim().min(1).max(10_000) });
const bodySchema = z.discriminatedUnion("action", [createConnection, createConnectionWithCredential, setCredential, revokeCredential, setEnabled, setRoute, testConnection]);

function safeConnection(connection: { id: string; providerKey: string; protocol: string; displayName: string; endpoint: string | null; region: string | null; status: string; health: string; credentialVersions: { id: string; displayHint: string | null; status: string }[] }) {
  const credential = connection.credentialVersions[0];
  return { id: connection.id, providerKey: connection.providerKey, protocol: connection.protocol, displayName: connection.displayName, endpoint: connection.endpoint, region: connection.region, status: connection.status, health: connection.health, credential: credential ? { id: credential.id, exists: true, displayHint: credential.displayHint, status: credential.status } : { exists: false } };
}
async function response(workspaceId: string) {
  const [connections, routes, readiness] = await Promise.all([
    prisma.providerConnection.findMany({ where: { workspaceId }, include: { credentialVersions: { where: { status: { in: ["ACTIVE", "RETIRED"] } }, orderBy: { credentialVersion: "desc" }, take: 1, select: { id: true, displayHint: true, status: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.providerRouteBinding.findMany({ where: { workspaceId }, include: { connection: { select: { id: true, displayName: true, providerKey: true, protocol: true, status: true } } }, orderBy: { routeSlot: "asc" } }),
    providerReadiness(workspaceId),
  ]);
  return NextResponse.json({ manifest: sanitizedProviderManifest(productManifest()), connections: connections.map(safeConnection), routes: routes.map(route => ({ id: route.id, routeSlot: route.routeSlot, connectionId: route.connectionId, modelId: route.modelId, configuration: safeConfiguration(route.configuration), connection: route.connection })), readiness });
}
async function testSubmittedConnection(input: z.infer<typeof testConnection>, manifest: ReturnType<typeof productManifest>) {
  const provider = manifest.providers.find(item => item.providerKey === input.providerKey);
  if (!provider || ![provider.protocol, ...Object.values(provider.capabilityProtocols ?? {})].includes(input.protocol as never)) throw new Error("PROVIDER_CONNECTION_PROTOCOL_INVALID");
  await validateProviderEndpoint(input.endpoint, { environment: process.env.NODE_ENV ?? "production", allowPrivateEndpoints: process.env.ALLOW_PRIVATE_PROVIDER_ENDPOINTS === "true", dns: { lookup: async hostname => (await import("node:dns/promises")).resolve4(hostname) } });
  const headers: Record<string, string> = input.providerKey === "anthropic" ? { "x-api-key": input.secret, "anthropic-version": "2023-06-01" } : input.providerKey === "gemini" ? { "x-goog-api-key": input.secret } : { authorization: `Bearer ${input.secret}` };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5_000);
  try { const result = await fetch(input.endpoint, { method: "HEAD", headers, signal: controller.signal, redirect: "error" }); if (result.status === 401 || result.status === 403) throw new Error("AUTHORIZATION_FAILED"); if (!result.ok && result.status !== 405) throw new Error("TEST_CONNECTION_FAILED"); return { ok: true, status: result.status }; }
  catch (error) { if (error instanceof Error && (error.message === "AUTHORIZATION_FAILED" || error.message === "TEST_CONNECTION_FAILED")) throw error; throw new Error("TEST_CONNECTION_FAILED"); }
  finally { clearTimeout(timer); }
}
function failure(error: unknown) {
  const message = error instanceof Error ? error.message.split(":")[0] : "";
  const code = error instanceof ProviderGatewayError && error.code !== "INTERNAL_PROVIDER_ERROR" ? error.code : ["PROVIDER_GATEWAY_MODEL_MANIFEST_MISSING", "PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID", "PROVIDER_GATEWAY_KEYRING_MISSING", "PROVIDER_CONNECTION_ENDPOINT_INVALID", "PROVIDER_CONNECTION_PROTOCOL_INVALID", "CAPABILITY_MISMATCH", "AUTHORIZATION_FAILED", "TEST_CONNECTION_FAILED"].includes(message) ? message : error instanceof ProviderGatewayError ? "INTERNAL_PROVIDER_ERROR" : message || "PROVIDER_SETTINGS_REQUEST_FAILED";
  const status = code === "WEB_IDENTITY_REQUIRED" ? 401 : code === "AUTHORIZATION_FAILED" || code.includes("ACCESS_DENIED") ? 403 : 400;
  return NextResponse.json({ error: code === "INTERNAL_PROVIDER_ERROR" ? "PROVIDER_GATEWAY_KEYRING_MISSING" : code }, { status });
}

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
    if (!cipher) throw new Error("PROVIDER_GATEWAY_KEYRING_MISSING");
    const repository = new ProviderGatewayRepository(prisma, cipher);
    if (input.action === "CREATE_CONNECTION" || input.action === "CREATE_CONNECTION_WITH_CREDENTIAL") {
      assertSafeConfiguration(input.configuration);
      await validateProviderEndpoint(input.endpoint, { environment: process.env.NODE_ENV ?? "production", allowPrivateEndpoints: process.env.ALLOW_PRIVATE_PROVIDER_ENDPOINTS === "true", dns: { lookup: async hostname => (await import("node:dns/promises")).resolve4(hostname) } });
      const provider = manifest.providers.find(item => item.providerKey === input.providerKey);
      if (!provider || ![provider.protocol, ...Object.values(provider.capabilityProtocols ?? {})].includes(input.protocol as never)) throw new Error("PROVIDER_CONNECTION_PROTOCOL_INVALID");
      if (input.action === "CREATE_CONNECTION_WITH_CREDENTIAL") await repository.createConnectionWithCredential(context, input);
      else await repository.createConnection(context, input);
    } else if (input.action === "SET_CREDENTIAL") {
      await repository.rotateCredential(context, input.connectionId, input.secret);
    } else if (input.action === "REVOKE_CREDENTIAL") {
      await repository.revokeCredential(context, input.credentialVersionId);
    } else if (input.action === "SET_ENABLED") {
      await repository.setConnectionEnabled(context, input.connectionId, input.enabled);
    } else {
      assertSafeConfiguration(input.configuration);
      const connection = await prisma.providerConnection.findUnique({ where: { id_workspaceId: { id: input.connectionId, workspaceId: context.workspaceId } }, select: { providerKey: true, protocol: true } });
      if (!connection) throw new Error("AUTHORIZATION_FAILED");
      validateRouteManifestSelection(manifest, { routeSlot: input.routeSlot as RouteSlot, providerKey: connection.providerKey, protocol: connection.protocol, modelId: input.modelId, configuration: input.configuration });
      await repository.setRoute(context, input);
    }
    return response(context.workspaceId);
  } catch (error) { return failure(error); }
}
