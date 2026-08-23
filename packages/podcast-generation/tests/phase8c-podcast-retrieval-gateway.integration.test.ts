/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { ProviderGatewayRepository, parseKeyring } from "@ai-cognitive/provider-gateway";
import { createPodcastProductionGatewayRuntime } from "../../../apps/worker/src/provider-gateway-runtime.js";
import { fixture } from "./phase3-durability.integration.test.js";

const keyring = JSON.stringify({ activeVersion: "v1", keys: { v1: Buffer.alloc(32, 13).toString("base64") } });
const manifest = JSON.stringify({ providers: [{ providerKey: "deterministic-test", displayName: "A", protocol: "TEST", adapterVersion: "test", models: [{ modelId: "deterministic-vector-v1", families: ["EMBEDDING"], confidence: "VERIFIED", embeddingDimensions: 4, embeddingPurposes: ["QUERY"] }] }, { providerKey: "fixture-b", displayName: "B", protocol: "TEST", adapterVersion: "test", models: [{ modelId: "fixture-b-model", families: ["EMBEDDING"], confidence: "VERIFIED", embeddingDimensions: 4, embeddingPurposes: ["QUERY"] }] }] });
const controls = { circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async (key: string) => ({ key, token: "test" }), release: async () => true }, validateEndpoint: async () => undefined };
type Data = Awaited<ReturnType<typeof fixture>>;
async function production(data: Data) {
  const store = new ProviderGatewayRepository(prisma, parseKeyring(keyring)!); const connectionA = await prisma.providerConnection.findFirstOrThrow({ where: { workspaceId: data.workspace.id, providerKey: "deterministic-test" } }); await store.rotateCredential({ workspaceId: data.workspace.id, userId: data.user.id }, connectionA.id, "a-secret");
  const calls = { a: 0, b: 0 };
  const runtime = createPodcastProductionGatewayRuntime({ ...process.env, PROVIDER_GATEWAY_KEYRING: keyring, PROVIDER_GATEWAY_MODEL_MANIFEST: manifest }, { ...controls, adapterResolver: () => ({ execute: async ({ snapshot, request }: any) => { if (snapshot.providerKey === "fixture-b") calls.b++; else calls.a++; return { response: { vectors: request.embedding.texts.map(() => [1, 0, 0, 0]), dimensions: 4 }, usage: { embeddingInputTokens: request.embedding.texts.length } }; } }) });
  return { store, runtime, calls };
}
async function receiptCounts(workspaceId: string) { return Promise.all([prisma.providerInvocation.count({ where: { workspaceId } }), prisma.providerInvocationAttempt.count({ where: { workspaceId, status: "SUCCEEDED" } }), prisma.providerUsageEvent.count({ where: { workspaceId } }), prisma.providerEmbeddingResult.count({ where: { workspaceId } })]); }

describe("Phase 8C Checkpoint 4B Podcast retrieval Gateway", () => {
  afterEach(async () => undefined);
  it("persists, replays, pins A→B, and rejects new incompatible or semantically changed queries", async () => {
    const data = await fixture(), value = await production(data), run = data.requested.run;
    const providerA = await value.runtime.createEmbeddingProviderForRun({ workspaceId: data.workspace.id, podcastGenerationRunId: run.id });
    const first = await providerA.embed({ texts: ["Q1"], model: providerA.identity.model, correlationId: "trace-1", operationKey: "PLANNING" });
    expect(value.calls).toEqual({ a: 1, b: 0 }); expect(await receiptCounts(data.workspace.id)).toEqual([2, 2, 2, 2]);
    const query = await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: data.workspace.id, idempotencyKey: `podcast-retrieval-query:${run.id}:PLANNING` }, include: { embeddingResult: true } }); expect(query.embeddingResult).toMatchObject({ consumedAt: null, purgedAt: null, ciphertext: expect.any(String), iv: expect.any(String), authTag: expect.any(String), keyVersion: expect.any(String) });
    const connectionB = await value.store.createConnection({ workspaceId: data.workspace.id, userId: data.user.id }, { providerKey: "fixture-b", protocol: "TEST", displayName: "b" }); await value.store.rotateCredential({ workspaceId: data.workspace.id, userId: data.user.id }, connectionB.id, "b-secret"); await value.store.setRoute({ workspaceId: data.workspace.id, userId: data.user.id }, { routeSlot: "EMBEDDING", connectionId: connectionB.id, modelId: "fixture-b-model" });
    const replay = await (await value.runtime.createEmbeddingProviderForRun({ workspaceId: data.workspace.id, podcastGenerationRunId: run.id })).embed({ texts: ["Q1"], model: providerA.identity.model, correlationId: "trace-2", operationKey: "PLANNING" }); expect(replay).toEqual(first); expect(value.calls).toEqual({ a: 1, b: 0 }); expect(await receiptCounts(data.workspace.id)).toEqual([2, 2, 2, 2]);
    const providerB = await value.runtime.createEmbeddingProviderForRun({ workspaceId: data.workspace.id, podcastGenerationRunId: run.id }); await expect(providerB.embed({ texts: ["Q2"], model: providerB.identity.model, correlationId: "trace-3", operationKey: "SEGMENT_CONTEXT:one" })).rejects.toThrow("PODCAST_RETRIEVAL_EMBEDDING_ROUTE_IDENTITY_GAP"); await expect(providerB.embed({ texts: ["Q2"], model: providerB.identity.model, correlationId: "trace-4", operationKey: "PLANNING" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" }); expect(value.calls).toEqual({ a: 1, b: 0 });
    await prisma.podcastGenerationRun.update({ where: { id: run.id }, data: { pipelineVersion: "changed-semantic-version" } }); const changed = await value.runtime.createEmbeddingProviderForRun({ workspaceId: data.workspace.id, podcastGenerationRunId: run.id }); await expect(changed.embed({ texts: ["Q1"], model: changed.identity.model, correlationId: "trace-5", operationKey: "PLANNING" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" }); expect(value.calls).toEqual({ a: 1, b: 0 });
    await value.runtime.close();
  }, 60_000);
});
