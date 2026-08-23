import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { PODCAST_GENERATION_OWNERSHIP_LOST, processPodcastGenerationRun } from "../src/index.js";
import { ProviderGatewayRepository, parseKeyring } from "@ai-cognitive/provider-gateway";
import { createPodcastProductionGatewayRuntime } from "../../../apps/worker/src/provider-gateway-runtime.js";
import { fixture } from "./phase3-durability.integration.test.js";

const keyring = JSON.stringify({ activeVersion: "v1", keys: { v1: Buffer.alloc(32, 9).toString("base64") } });
const manifest = JSON.stringify({ providers: [{ providerKey: "fixture", displayName: "Fixture", protocol: "TEST", adapterVersion: "test", models: [{ modelId: "fixture-model", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }] }, { providerKey: "fixture-b", displayName: "Fixture B", protocol: "TEST", adapterVersion: "test", models: [{ modelId: "fixture-b-model", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }] }] });
const controls = { circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async (key: string) => ({ key, token: "test" }), release: async () => true }, validateEndpoint: async () => undefined };

type Data = Awaited<ReturnType<typeof fixture>>;
async function production(data: Data) {
  await prisma.podcastGenerationRun.update({ where: { id: data.requested.run.id }, data: { provider: "fixture", model: "fixture-model", modelVersion: null, modelVersionKey: "" } });
  const store = new ProviderGatewayRepository(prisma, parseKeyring(keyring)!);
  const connection = await store.createConnection({ workspaceId: data.workspace.id, userId: data.user.id }, { providerKey: "fixture", protocol: "TEST", displayName: "fixture" });
  await store.rotateCredential({ workspaceId: data.workspace.id, userId: data.user.id }, connection.id, "fixture-secret");
  await store.setRoute({ workspaceId: data.workspace.id, userId: data.user.id }, { routeSlot: "PODCAST_SCRIPT", connectionId: connection.id, modelId: "fixture-model" });
  const calls = new Map<string, number>(), inputs = new Map<string, any>(), outputs = new Map<string, any>();
  const runtime = createPodcastProductionGatewayRuntime({ ...process.env, PROVIDER_GATEWAY_KEYRING: keyring, PROVIDER_GATEWAY_MODEL_MANIFEST: manifest }, { ...controls, adapterResolver: () => ({ execute: async ({ request }: any) => {
    const input = JSON.parse(request.text.messages[0].content), stage = input.metadata.stage, hosts = input.hosts, memory = input.context?.find((item: any) => item.sourceBlockEvidenceSpans?.length)?.memoryItemId ?? input.context?.[0]?.memoryItemId ?? input.availableMemoryIds?.[0];
    calls.set(stage, (calls.get(stage) ?? 0) + 1); inputs.set(stage, input);
    const structured = stage === "EPISODE_PLANNING" ? { centralQuestion: "Why durable replay?", listenerStartingPoint: "start", listenerTakeaway: "takeaway", coreThesis: "evidence", tensions: ["a"], surprisingIdeas: ["b"], misconceptions: ["c"], keyConcepts: ["d"], candidateStories: [], candidateExamples: ["e"], openQuestions: ["f"] } : stage === "NARRATIVE_DESIGN" ? { arcType: "arc", intellectualProgression: ["one", "two", "three"], openingMove: "open", closingMove: "close" } : stage === "SEGMENT_OUTLINE" ? { segments: [{ ordinal: 1, purpose: "purpose", internalLabel: "label", targetDurationSeconds: 30, narrativeFunction: "function", keyQuestions: ["why"], requiredMemoryIds: [memory], optionalMemoryIds: [] }] } : stage === "SEGMENT_DRAFTING" ? { utterances: [{ ordinal: 1, speakerHostId: hosts[0].id, text: "Grounded evidence supports durable recovery.", utteranceType: "STATEMENT", substantive: true, isDirectQuote: false, evidence: [{ memoryItemId: memory }] }, { ordinal: 2, speakerHostId: hosts[1].id, text: "How do we verify it?", utteranceType: "QUESTION", substantive: false, isDirectQuote: false, evidence: [] }] } : { utterances: input.dialogue.utterances.map((item: any) => ({ ordinal: item.ordinal, text: item.text })) };
    outputs.set(stage, structured); return { response: { type: "STRUCTURED", structured }, usage: { inputTokens: 1, outputTokens: 1 } };
  } }) });
  return { runtime, store, calls, inputs, outputs, deps: { providerForRun: runtime.createProviderForRun, embeddingProvider: data.retrievalEmbeddings } };
}
async function resetForReplay(runId: string) { await prisma.podcastGenerationRun.update({ where: { id: runId }, data: { status: "QUEUED", executionClaimToken: null, executionClaimedAt: null, executionLeaseUntil: null, errorCode: null } }); }
async function accounting(workspaceId: string, invocationId?: string) {
  const where = invocationId ? { workspaceId, invocationId } : { workspaceId };
  return Promise.all([
    prisma.providerInvocation.count({ where: invocationId ? { id: invocationId, workspaceId } : { workspaceId } }),
    prisma.providerInvocationAttempt.count({ where: { ...where, status: "SUCCEEDED" } }),
    prisma.providerUsageEvent.count({ where }),
    prisma.providerTextResult.count({ where }),
  ]);
}
const planningInput = (data: Data) => ({ metadata: { stage: "EPISODE_PLANNING", episodeId: data.episode.id, provider: "fixture", model: "fixture-model", correlationId: data.requested.run.id, tokenBudget: 4_000 }, style: {}, hosts: [], context: [] });

describe("Phase 8C persisted Podcast Gateway replay", () => {
  afterEach(async () => { /* the imported Phase 3 fixture owns workspace cleanup */ });

  it.each([
    ["EPISODE_PLANNING", "afterPlanning"],
    ["SEGMENT_DRAFTING", "afterSegmentDraft"],
    ["HUMANIZATION", "afterSegmentHumanization"],
  ] as const)("replays consumed %s before stage advance without another remote call", async (stage, point) => {
    const data = await fixture(), value = await production(data);
    await expect(processPodcastGenerationRun(data.requested.run.id, { ...value.deps, faultInjector: fault => { if (fault === point) throw new Error(`CRASH_${stage}`); } })).rejects.toThrow(`CRASH_${stage}`);
    expect(value.calls.get(stage)).toBe(1);
    const receipt = await prisma.providerTextResult.findFirstOrThrow({ where: { workspaceId: data.workspace.id, invocation: { idempotencyKey: { contains: `:${stage}` } } } });
    expect(receipt).toMatchObject({ consumedAt: expect.any(Date), purgedAt: expect.any(Date), ciphertext: null });
    await resetForReplay(data.requested.run.id);
    await processPodcastGenerationRun(data.requested.run.id, value.deps);
    expect(value.calls.get(stage)).toBe(1);
    expect(await prisma.podcastGenerationRun.findUniqueOrThrow({ where: { id: data.requested.run.id } })).toMatchObject({ status: "SUCCEEDED", stage: "COMPLETED" });
  }, 60_000);

  it.each([
    ["planning plan", "afterPlanning", async (data: Data) => { const row = await prisma.episodePlan.findUniqueOrThrow({ where: { podcastGenerationRunId: data.requested.run.id } }); await prisma.episodePlan.update({ where: { id: row.id }, data: { coreThesis: "corrupted" } }); }],
    ["narrative", "afterNarrative", async (data: Data) => { const row = await prisma.episodeNarrative.findUniqueOrThrow({ where: { podcastGenerationRunId: data.requested.run.id } }); await prisma.episodeNarrative.update({ where: { id: row.id }, data: { openingMove: "corrupted" } }); }],
    ["outline", "afterOutline", async (data: Data) => { const row = await prisma.episodeSegment.findFirstOrThrow({ where: { podcastGenerationRunId: data.requested.run.id } }); await prisma.episodeSegment.update({ where: { id: row.id }, data: { purpose: "corrupted" } }); }],
    ["draft", "afterSegmentDraft", async (data: Data) => { const row = await prisma.podcastUtterance.findFirstOrThrow({ where: { podcastGenerationRunId: data.requested.run.id } }); await prisma.podcastUtterance.update({ where: { id: row.id }, data: { draftText: "corrupted" } }); }],
    ["humanization", "afterSegmentHumanization", async (data: Data) => { const row = await prisma.podcastUtterance.findFirstOrThrow({ where: { podcastGenerationRunId: data.requested.run.id } }); await prisma.podcastUtterance.update({ where: { id: row.id }, data: { humanizedAt: null } }); }],
  ] as const)("detects persisted %s corruption without another remote call", async (_name, point, corrupt) => {
    const data = await fixture(), value = await production(data);
    await expect(processPodcastGenerationRun(data.requested.run.id, { ...value.deps, faultInjector: fault => { if (fault === point) throw new Error("STOP_AFTER_CONSUME"); } })).rejects.toThrow("STOP_AFTER_CONSUME");
    const remote = [...value.calls.values()].reduce((sum, count) => sum + count, 0);
    await corrupt(data); await resetForReplay(data.requested.run.id);
    await expect(processPodcastGenerationRun(data.requested.run.id, value.deps)).rejects.toThrow("PODCAST_TEXT_RECONCILIATION_REQUIRED");
    expect([...value.calls.values()].reduce((sum, count) => sum + count, 0)).toBe(remote);
  }, 60_000);

  it.each([
    ["actor-null", async (data: Data) => prisma.job.update({ where: { id: data.requested.run.jobId }, data: { userId: null } }), "PODCAST_DURABLE_PRINCIPAL_MISSING"],
    ["non-member", async (data: Data) => prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: data.workspace.id, userId: data.user.id } } }), "PODCAST_DURABLE_PRINCIPAL_MISSING"],
    ["workspace-mismatch", async (data: Data) => prisma.job.update({ where: { id: data.requested.run.jobId }, data: { workspaceId: null } }), "PODCAST_DURABLE_PRINCIPAL_WORKSPACE_MISMATCH"],
  ] as const)("fails closed for durable Podcast principal %s before any remote call", async (_name, mutate, code) => {
    const data = await fixture(), value = await production(data);
    await mutate(data);
    await expect(processPodcastGenerationRun(data.requested.run.id, value.deps)).rejects.toThrow(code);
    expect([...value.calls.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  }, 60_000);

  it("rejects a new operation when the current route does not match the persisted provider identity", async () => {
    const data = await fixture(), value = await production(data);
    await prisma.podcastGenerationRun.update({ where: { id: data.requested.run.id }, data: { provider: "fixture-b", model: "fixture-b-model" } });
    await expect(processPodcastGenerationRun(data.requested.run.id, value.deps)).rejects.toThrow("PODCAST_ROUTE_IDENTITY_MODEL_GAP");
    expect([...value.calls.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  }, 60_000);

  it("recovers a durable planning receipt under owner B after owner A loses the real PodcastGenerationRun lease", async () => {
    const data = await fixture(), value = await production(data);
    let entered!: () => void, release!: () => void;
    const receiptReady = new Promise<void>(resolve => { entered = resolve; });
    const allowAConsume = new Promise<void>(resolve => { release = resolve; });
    const ownerA = processPodcastGenerationRun(data.requested.run.id, { ...value.deps, faultInjector: async (point, metadata) => {
      if (point === "afterTextReceipt" && metadata.stage === "EPISODE_PLANNING") { entered(); await allowAConsume; }
    } });
    await receiptReady;
    const planning = await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: data.workspace.id, idempotencyKey: { contains: ":EPISODE_PLANNING" } }, include: { textResult: true } });
    expect(planning.textResult).toMatchObject({ consumedAt: null, purgedAt: null });
    expect(await prisma.episodePlan.count({ where: { podcastGenerationRunId: data.requested.run.id } })).toBe(0);
    expect(await accounting(data.workspace.id, planning.id)).toEqual([1, 1, 1, 1]);
    await prisma.podcastGenerationRun.update({ where: { id: data.requested.run.id }, data: { executionLeaseUntil: new Date(Date.now() - 1_000) } });
    await processPodcastGenerationRun(data.requested.run.id, value.deps);
    release();
    await expect(ownerA).rejects.toThrow(PODCAST_GENERATION_OWNERSHIP_LOST);
    const recovered = await prisma.providerInvocation.findUniqueOrThrow({ where: { id_workspaceId: { id: planning.id, workspaceId: data.workspace.id } }, include: { textResult: true } });
    expect(recovered.snapshotId).toBe(planning.snapshotId);
    expect(recovered.textResult).toMatchObject({ consumedAt: expect.any(Date), purgedAt: expect.any(Date), ciphertext: null, iv: null, authTag: null, keyVersion: null });
    expect(await prisma.episodePlan.count({ where: { podcastGenerationRunId: data.requested.run.id } })).toBe(1);
    expect(value.calls.get("EPISODE_PLANNING")).toBe(1);
    expect(await accounting(data.workspace.id, planning.id)).toEqual([1, 1, 1, 1]);
    expect(await prisma.podcastGenerationRun.findUniqueOrThrow({ where: { id: data.requested.run.id } })).toMatchObject({ status: "SUCCEEDED", stage: "COMPLETED" });
  }, 60_000);

  it("pins a durable Podcast receipt to route A when the current route changes to B", async () => {
    const data = await fixture(), value = await production(data), run = data.requested.run;
    const providerA = await value.runtime.createProviderForRun({ workspaceId: data.workspace.id, podcastGenerationRunId: run.id, provider: "fixture", model: "fixture-model" });
    const input = planningInput(data), first = await providerA.plan(input);
    const invocation = await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: data.workspace.id, idempotencyKey: { contains: ":EPISODE_PLANNING" } } });
    const before = await accounting(data.workspace.id, invocation.id);
    const connectionB = await value.store.createConnection({ workspaceId: data.workspace.id, userId: data.user.id }, { providerKey: "fixture-b", protocol: "TEST", displayName: "fixture-b" });
    await value.store.rotateCredential({ workspaceId: data.workspace.id, userId: data.user.id }, connectionB.id, "fixture-b-secret");
    await value.store.setRoute({ workspaceId: data.workspace.id, userId: data.user.id }, { routeSlot: "PODCAST_SCRIPT", connectionId: connectionB.id, modelId: "fixture-b-model" });
    const providerB = await value.runtime.createProviderForRun({ workspaceId: data.workspace.id, podcastGenerationRunId: run.id, provider: "fixture", model: "fixture-model" });
    await expect(providerB.plan(input)).resolves.toEqual(first);
    expect(value.calls.get("EPISODE_PLANNING")).toBe(1);
    expect(await accounting(data.workspace.id, invocation.id)).toEqual(before);
    await providerB.consumeTextResult(`${run.id}:EPISODE_PLANNING`, { consumerKind: "PODCAST_EPISODE_PLAN", consumerKey: run.id, consumerFingerprint: "a".repeat(64) }, async ({ tx }) => { await (tx as typeof prisma).workspace.update({ where: { id: data.workspace.id }, data: { name: "pinned-route-a-materialized" } }); });
    expect(await prisma.workspace.findUniqueOrThrow({ where: { id: data.workspace.id } })).toMatchObject({ name: "pinned-route-a-materialized" });
    expect(await accounting(data.workspace.id, invocation.id)).toEqual(before);
  });

  it("rejects changed semantic stage input after a durable result without returning or materializing the old output", async () => {
    const data = await fixture(), value = await production(data), provider = await value.runtime.createProviderForRun({ workspaceId: data.workspace.id, podcastGenerationRunId: data.requested.run.id, provider: "fixture", model: "fixture-model" });
    await provider.plan(planningInput(data));
    const before = await accounting(data.workspace.id), changed = { ...planningInput(data), context: [{ sourceDocumentId: "changed-source", extractionId: "changed-extraction", chunkSetId: "changed-chunks", analysisRunId: "changed-analysis", memoryItemId: "meaningful-change", artifactId: "changed-artifact", content: "meaningful semantic change", score: 1, selectionReason: "test", tokenEstimate: 1, sourceBlockEvidenceSpans: [] }] };
    await expect(provider.plan(changed)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await accounting(data.workspace.id)).toEqual(before);
    expect(await prisma.episodePlan.count({ where: { podcastGenerationRunId: data.requested.run.id } })).toBe(0);
  });

  it("rejects a changed prompt version after a durable result without another paid operation", async () => {
    const data = await fixture(), value = await production(data), input = planningInput(data);
    const first = await value.runtime.createProviderForRun({ workspaceId: data.workspace.id, podcastGenerationRunId: data.requested.run.id, provider: "fixture", model: "fixture-model" });
    await first.plan(input);
    const before = await accounting(data.workspace.id);
    await prisma.podcastGenerationRun.update({ where: { id: data.requested.run.id }, data: { promptVersion: "phase8c-version-conflict" } });
    const changed = await value.runtime.createProviderForRun({ workspaceId: data.workspace.id, podcastGenerationRunId: data.requested.run.id, provider: "fixture", model: "fixture-model" });
    await expect(changed.plan(input)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await accounting(data.workspace.id)).toEqual(before);
  });
});
