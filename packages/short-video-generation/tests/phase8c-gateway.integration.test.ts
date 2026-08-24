import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { DeterministicProviderHttpTransport, ProviderExecutionRepository, ProviderGatewayRepository, ProviderRegistry, WorkspaceMembershipExecutionAuthorizer, createProductionProviderGateway, createProviderAdapterResolver, testCipher } from "@ai-cognitive/provider-gateway";
import { GatewayShortVideoProvider, GatewayShortVideoTtsProvider } from "../src/index.js";

const owned: Array<{ workspaceId: string; userId: string; jobId: string; runId: string }> = [];
const plan = { centralQuestion: "How does evidence change judgement?", viewerAssumption: "Answers arrive quickly.", coreInsight: "Evidence first.", cognitiveShift: "Verify before deciding.", hook: "Change the question.", supportingIdeas: ["evidence"], evidenceStrategy: "grounded", ending: "Ask for evidence.", targetDurationSeconds: 15, tone: "grounded" };
function wav() { const samples = 8_000, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer); bytes.set(new TextEncoder().encode("RIFF")); view.setUint32(4, bytes.length - 8, true); bytes.set(new TextEncoder().encode("WAVEfmt "), 8); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8_000, true); view.setUint32(28, 16_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); bytes.set(new TextEncoder().encode("data"), 36); view.setUint32(40, samples * 2, true); return bytes; }

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), cipher = testCipher();
  await prisma.workspace.create({ data: { id: workspaceId, name: workspaceId } });
  await prisma.user.create({ data: { id: userId, email: `${userId}@checkpoint6.test` } });
  await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "OWNER" } });
  const project = await prisma.shortVideoProject.create({ data: { workspaceId, name: "Checkpoint 6" } });
  const style = await prisma.shortVideoStyleProfile.create({ data: { workspaceId, shortVideoProjectId: project.id, version: 1, targetDurationSeconds: 15 } });
  const job = await prisma.job.create({ data: { workspaceId, userId, type: "short-video.generation", payload: {} } });
  const run = await prisma.shortVideoGenerationRun.create({ data: { workspaceId, shortVideoProjectId: project.id, styleProfileId: style.id, jobId: job.id, provider: "deepseek", model: "deepseek-chat", modelVersion: "v1", modelVersionKey: "v1", promptVersion: "p1", pipelineVersion: "pipeline", retrievalVersion: "r1", scenePlannerVersion: "s1", captionVersion: "c1", audioVersion: "a1", renderVersion: "render", generationIdentityHash: randomUUID(), idempotencyKey: randomUUID(), status: "RUNNING", stage: "VIDEO_PLANNING", executionClaimToken: "owner", executionLeaseUntil: new Date(Date.now() + 60_000) } });
  owned.push({ workspaceId, userId, jobId: job.id, runId: run.id });
  const store = new ProviderGatewayRepository(prisma, cipher);
  const connection = await store.createConnection({ workspaceId, userId }, { providerKey: "deepseek", protocol: "OPENAI_COMPATIBLE", displayName: "checkpoint6-text" });
  await store.rotateCredential({ workspaceId, userId }, connection.id, "checkpoint6-text-credential");
  await store.setRoute({ workspaceId, userId }, { routeSlot: "SHORT_VIDEO_SCRIPT", connectionId: connection.id, modelId: "deepseek-chat", configuration: { modelVersion: "v1" } });
  const transport = new DeterministicProviderHttpTransport(() => ({ status: 200, headers: {}, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) }, finish_reason: "stop" }] }) }));
  const registry = new ProviderRegistry();
  registry.register({ providerKey: "deepseek", displayName: "DeepSeek", protocol: "OPENAI_COMPATIBLE", adapterVersion: "checkpoint6", models: [{ modelId: "deepseek-chat", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }] });
  const repository = new ProviderExecutionRepository(prisma, cipher);
  const authorizer = new WorkspaceMembershipExecutionAuthorizer(prisma);
  const gateway = createProductionProviderGateway(registry, { resolveWorkspaceRoute: input => store.resolveWorkspaceRoute(input) }, { resolve: async () => undefined }, createProviderAdapterResolver(transport), { authorize: (principal, input) => authorizer.authorizeExecution(principal, input.workspaceId), assertRouteUsable: async () => undefined, validateEndpoint: async () => undefined, assertBudget: () => undefined, repository, rate: { admit: async () => undefined }, concurrency: { acquire: async () => ({ key: "checkpoint6", token: "lease" }), release: async () => true }, circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined } });
  const runtime = { gateway, repository, workspaceId, userId, runId: run.id, provider: run.provider, model: run.model, modelVersion: run.modelVersion, pipelineVersion: run.pipelineVersion, promptVersion: run.promptVersion };
  return { workspaceId, userId, run, store, transport, provider: new GatewayShortVideoProvider(runtime), replay: () => new GatewayShortVideoProvider(runtime) };
}

afterEach(async () => {
  for (const item of owned.splice(0)) {
    await prisma.shortVideoGenerationRun.deleteMany({ where: { id: item.runId } });
    await prisma.job.deleteMany({ where: { id: item.jobId } });
    await prisma.providerTextResult.deleteMany({ where: { workspaceId: item.workspaceId } });
    await prisma.providerSpeechResult.deleteMany({ where: { workspaceId: item.workspaceId } });
    await prisma.providerUsageEvent.deleteMany({ where: { workspaceId: item.workspaceId } });
    await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId: item.workspaceId } });
    await prisma.providerInvocation.deleteMany({ where: { workspaceId: item.workspaceId } });
    await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId: item.workspaceId } });
    await prisma.providerRouteBinding.deleteMany({ where: { workspaceId: item.workspaceId } });
    await prisma.providerCredentialVersion.deleteMany({ where: { workspaceId: item.workspaceId } });
    await prisma.providerConnection.deleteMany({ where: { workspaceId: item.workspaceId } });
    await prisma.shortVideoProject.deleteMany({ where: { workspaceId: item.workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId: item.workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: item.workspaceId } });
    await prisma.user.deleteMany({ where: { id: item.userId } });
}
});

async function speechFixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), cipher = testCipher();
  await prisma.workspace.create({ data: { id: workspaceId, name: workspaceId } });
  await prisma.user.create({ data: { id: userId, email: `${userId}@checkpoint6.test` } });
  await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "OWNER" } });
  const project = await prisma.shortVideoProject.create({ data: { workspaceId, name: "Checkpoint 6 speech" } });
  const style = await prisma.shortVideoStyleProfile.create({ data: { workspaceId, shortVideoProjectId: project.id, version: 1, targetDurationSeconds: 15 } });
  const job = await prisma.job.create({ data: { workspaceId, userId, type: "short-video.generation", payload: {} } });
  const run = await prisma.shortVideoGenerationRun.create({ data: { workspaceId, shortVideoProjectId: project.id, styleProfileId: style.id, jobId: job.id, provider: "deepseek", model: "deepseek-chat", modelVersion: "v1", modelVersionKey: "v1", promptVersion: "p1", pipelineVersion: "pipeline", retrievalVersion: "r1", scenePlannerVersion: "s1", captionVersion: "c1", audioVersion: "a1", renderVersion: "render", generationIdentityHash: randomUUID(), idempotencyKey: randomUUID(), status: "RUNNING", stage: "NARRATION_SYNTHESIS", executionClaimToken: "owner", executionLeaseUntil: new Date(Date.now() + 60_000) } });
  owned.push({ workspaceId, userId, jobId: job.id, runId: run.id });
  const store = new ProviderGatewayRepository(prisma, cipher), context = { workspaceId, userId };
  const connection = await store.createConnection(context, { providerKey: "openai", protocol: "TEST", displayName: "checkpoint6-speech" });
  await store.rotateCredential(context, connection.id, "checkpoint6-speech-credential");
  const routeConfiguration = { modelVersion: "v1", providerVoiceId: "checkpoint6", voiceVersion: "1", speakingRate: 1, pitch: 0, outputFormat: "wav" };
  await store.setRoute(context, { routeSlot: "SHORT_VIDEO_TTS", connectionId: connection.id, modelId: "checkpoint6-tts", configuration: routeConfiguration });
  const pin = { provider: "openai", model: "checkpoint6-tts", modelVersion: "v1", providerVoiceId: "checkpoint6", voiceVersion: "1", speakingRate: 1, pitch: 0, style: null, language: "zh-CN", outputFormat: "wav", voiceIdentityHash: "c".repeat(64) };
  let calls = 0;
  const registry = new ProviderRegistry();
  registry.register({ providerKey: "openai", displayName: "OpenAI", protocol: "TEST", adapterVersion: "checkpoint6", models: [{ modelId: "checkpoint6-tts", families: ["SPEECH"], confidence: "VERIFIED", speechFormats: ["wav"], languages: ["zh-CN"] }] });
  const repository = new ProviderExecutionRepository(prisma, cipher);
  const gateway = createProductionProviderGateway(registry, { resolveWorkspaceRoute: input => store.resolveWorkspaceRoute(input) }, { resolve: async () => undefined }, () => ({ execute: async () => ({ response: { bytes: wav(), mediaType: "audio/wav", format: "wav", sampleRate: 8_000, channels: 1, durationMs: 1_000 }, usage: { speechInputCharacters: 1 }, remoteRequestId: `speech-${++calls}` }) }), { authorize: (principal, input) => new WorkspaceMembershipExecutionAuthorizer(prisma).authorizeExecution(principal, input.workspaceId), assertRouteUsable: async () => undefined, validateEndpoint: async () => undefined, assertBudget: () => undefined, repository, rate: { admit: async () => undefined }, concurrency: { acquire: async () => ({ key: "checkpoint6", token: "lease" }), release: async () => true }, circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined } });
  const runtime = { gateway, repository, workspaceId, userId, runId: run.id, pipelineVersion: run.pipelineVersion, pin };
  return { workspaceId, userId, run, store, context, routeConfiguration, provider: new GatewayShortVideoTtsProvider(runtime), replay: () => new GatewayShortVideoTtsProvider(runtime), calls: () => calls };
}
afterAll(() => prisma.$disconnect());

describe("Phase 8C Short Video TEXT receipt handoff", () => {
  it("keeps a remote plan receipt encrypted until the atomic destination consume, then verifies exact replay", async () => {
    const value = await fixture();
    await expect(value.provider.plan({ style: { version: 1 }, context: [], targetDurationSeconds: 15 })).resolves.toEqual(plan);
    expect(value.transport.calls).toHaveLength(1);
    const receipt = await prisma.providerTextResult.findFirstOrThrow({ where: { workspaceId: value.workspaceId } });
    expect(receipt).toMatchObject({ ciphertext: expect.any(String), iv: expect.any(String), authTag: expect.any(String), keyVersion: expect.any(String), consumedAt: null, purgedAt: null });
    const replay = value.replay();
    await expect(replay.plan({ style: { version: 1 }, context: [], targetDurationSeconds: 15 })).resolves.toEqual(plan);
    expect(value.transport.calls).toHaveLength(1);
    const fingerprint = "a".repeat(64), consumer = { consumerKind: "SHORT_VIDEO_PLAN", consumerKey: value.run.id, consumerFingerprint: fingerprint };
    await replay.consumeTextResult<typeof plan>(`short-video-plan:${value.run.id}`, consumer, async ({ tx, output }) => {
      await (tx as typeof prisma).shortVideoPlan.create({ data: { shortVideoGenerationRunId: value.run.id, workspaceId: value.workspaceId, ...output } });
    });
    expect(await prisma.providerTextResult.findUniqueOrThrow({ where: { invocationId: receipt.invocationId } })).toMatchObject({ consumedAt: expect.any(Date), purgedAt: expect.any(Date), ciphertext: null, iv: null, authTag: null, keyVersion: null });
    await expect(replay.verifyConsumedTextResult(`short-video-plan:${value.run.id}`, consumer)).resolves.toBe("EXACT");
    await expect(replay.verifyConsumedTextResult(`short-video-plan:${value.run.id}`, { ...consumer, consumerFingerprint: "b".repeat(64) })).resolves.toBe("RECONCILIATION_REQUIRED");
  });

  it("replays the original plan across a route change and rejects changed semantics without another remote call", async () => {
    const value = await fixture();
    const input = { style: { version: 1 }, context: [], targetDurationSeconds: 15 };
    await value.provider.plan(input);
    const routeB = await value.store.createConnection({ workspaceId: value.workspaceId, userId: value.userId }, { providerKey: "deepseek", protocol: "OPENAI_COMPATIBLE", displayName: "checkpoint6-text-b" });
    await value.store.rotateCredential({ workspaceId: value.workspaceId, userId: value.userId }, routeB.id, "checkpoint6-text-b-credential");
    await value.store.setRoute({ workspaceId: value.workspaceId, userId: value.userId }, { routeSlot: "SHORT_VIDEO_SCRIPT", connectionId: routeB.id, modelId: "deepseek-chat", configuration: { modelVersion: "v1" } });
    await expect(value.replay().plan(input)).resolves.toEqual(plan);
    await expect(value.replay().plan({ ...input, targetDurationSeconds: 16 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(value.transport.calls).toHaveLength(1);
  });

  it("pins TTS replay to its existing receipt and blocks an incompatible new unit before remote execution", async () => {
    const value = await speechFixture(), input = { text: "A durable narration unit.", language: "zh-CN", operationKey: `short-video-tts:${value.run.id}:narration:0`, semanticIdentity: { unit: 0, textHash: "a".repeat(64) } };
    await value.provider.synthesize(input);
    const routeB = await value.store.createConnection(value.context, { providerKey: "openai", protocol: "TEST", displayName: "checkpoint6-speech-b" });
    await value.store.rotateCredential(value.context, routeB.id, "checkpoint6-speech-b-credential");
    await value.store.setRoute(value.context, { routeSlot: "SHORT_VIDEO_TTS", connectionId: routeB.id, modelId: "checkpoint6-tts", configuration: value.routeConfiguration });
    await expect(value.replay().synthesize(input)).resolves.toMatchObject({ mediaType: "audio/wav" });
    await expect(value.replay().synthesize({ ...input, text: "Changed narration text." })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await value.store.setRoute(value.context, { routeSlot: "SHORT_VIDEO_TTS", connectionId: routeB.id, modelId: "checkpoint6-tts", configuration: { ...value.routeConfiguration, providerVoiceId: "incompatible" } });
    await expect(value.replay().synthesize({ ...input, operationKey: `${input.operationKey}:next`, semanticIdentity: { unit: 1, textHash: "b".repeat(64) } })).rejects.toThrow("SHORT_VIDEO_TTS_ROUTE_IDENTITY_MISMATCH");
    expect(value.calls()).toBe(1);
  });
});
