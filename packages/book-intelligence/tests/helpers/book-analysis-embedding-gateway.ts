import { prisma } from "@ai-cognitive/db";
import { createProductionProviderGateway, ProviderExecutionRepository, ProviderGatewayRepository, ProviderRegistry, WorkspaceMembershipExecutionAuthorizer, testCipher, type ProviderAdapter } from "@ai-cognitive/provider-gateway";
import { DeterministicFakeEmbeddingProvider } from "../../src/embeddings.js";

export class DeterministicGatewayRetrievalEmbeddingProvider extends DeterministicFakeEmbeddingProvider {
  override readonly identity = { provider: "deterministic-test", model: "deterministic-vector-v1", embeddingVersion: "gateway", dimensions: 4 };
}

export async function createBookAnalysisEmbeddingGatewayFixture(input: { workspaceId: string; userId: string; pauseRemote?: boolean; maxEmbeddingInputs?: number }) {
  const cipher = testCipher();
  const store = new ProviderGatewayRepository(prisma, cipher);
  const connection = await store.createConnection({ workspaceId: input.workspaceId, userId: input.userId }, { providerKey: "deterministic-test", protocol: "TEST", displayName: "phase2 durable embedding fixture", endpoint: "https://deterministic-test.fixture.test/v1" });
  await store.rotateCredential({ workspaceId: input.workspaceId, userId: input.userId }, connection.id, "phase2-test-credential");
  const capability = { modelId: "deterministic-vector-v1", families: ["EMBEDDING"] as const, confidence: "VERIFIED" as const, embeddingDimensions: 4, maxEmbeddingInputs: input.maxEmbeddingInputs ?? 1024, embeddingPurposes: ["DOCUMENT"] as const };
  await store.setRoute({ workspaceId: input.workspaceId, userId: input.userId }, { routeSlot: "EMBEDDING", connectionId: connection.id, modelId: capability.modelId });
  const registry = new ProviderRegistry();
  registry.register({ providerKey: "deterministic-test", displayName: "deterministic test", protocol: "TEST", adapterVersion: "phase8c-test", models: [capability] });
  const provider = new DeterministicFakeEmbeddingProvider();
  const retrievalEmbeddings = new DeterministicGatewayRetrievalEmbeddingProvider();
  const calls: string[][] = [];
  let markRemoteEntered!: () => void;
  const remoteEntered = new Promise<void>((resolve) => { markRemoteEntered = resolve; });
  let releaseRemote!: () => void;
  const remoteReleased = new Promise<void>((resolve) => { releaseRemote = resolve; });
  if (!input.pauseRemote) releaseRemote();
  const adapter: ProviderAdapter = { execute: async ({ request }) => { const texts = [...(request.embedding?.texts ?? [])]; calls.push(texts); markRemoteEntered(); await remoteReleased; return { response: { vectors: await provider.embed({ texts }), dimensions: 4 }, usage: { embeddingInputTokens: texts.length } }; } };
  const repository = new ProviderExecutionRepository(prisma, cipher);
  const gateway = createProductionProviderGateway(registry, { resolveWorkspaceRoute: value => store.resolveWorkspaceRoute(value) }, { resolve: async () => undefined }, () => adapter, { authorize: (principal, request) => new WorkspaceMembershipExecutionAuthorizer(prisma).authorizeExecution(principal, request.workspaceId), assertRouteUsable: async () => undefined, validateEndpoint: async () => undefined, assertBudget: () => undefined, repository, circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async key => ({ key, token: "phase2-fixture" }), release: async () => true }, maxAttempts: 1 });
  return { embeddingGateway: { gateway, repository, userId: input.userId, maxEmbeddingInputs: capability.maxEmbeddingInputs }, retrievalEmbeddings, remoteCallCount: () => calls.length, remoteInputs: () => calls.map(call => [...call]), remoteEntered, releaseRemote };
}

/** Clears only the Provider Gateway state owned by a fixture workspace. */
export async function clearBookAnalysisEmbeddingGatewayFixtureState(workspaceId: string) {
  await prisma.providerEmbeddingResult.deleteMany({ where: { workspaceId } });
  await prisma.providerUsageEvent.deleteMany({ where: { workspaceId } });
  await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId } });
  await prisma.providerInvocation.deleteMany({ where: { workspaceId } });
  await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId } });
  await prisma.providerRouteBinding.deleteMany({ where: { workspaceId } });
  await prisma.providerCredentialVersion.deleteMany({ where: { workspaceId } });
  await prisma.providerConnection.deleteMany({ where: { workspaceId } });
  await prisma.providerAuditEvent.deleteMany({ where: { workspaceId } });
}
