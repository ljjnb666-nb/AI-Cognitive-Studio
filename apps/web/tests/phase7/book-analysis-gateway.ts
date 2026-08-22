import { prisma } from "@ai-cognitive/db";
import type { ProcessBookAnalysisDependencies } from "@ai-cognitive/book-intelligence";
import { ProviderExecutionRepository, ProviderGatewayError, testCipher, type GatewayRequest, type ProviderGateway } from "../../../../packages/provider-gateway/src/index.js";
import { clearBookAnalysisEmbeddingGatewayFixtureState, createBookAnalysisEmbeddingGatewayFixture } from "../../../../packages/book-intelligence/tests/helpers/book-analysis-embedding-gateway.js";

type Fixture = Awaited<ReturnType<typeof createBookAnalysisEmbeddingGatewayFixture>>;
const prefix = "book-analysis-embeddings:";

/** Test-only dynamic Phase 7 fixture; all principal data is durable. */
export function createPhase7BookAnalysisEmbeddingGateway(): NonNullable<ProcessBookAnalysisDependencies["embeddingGateway"]> & { close(): Promise<void> } {
  const fixtures = new Map<string, Fixture>();
  const repository = new ProviderExecutionRepository(prisma, testCipher());
  const resolve = async (request: GatewayRequest): Promise<Fixture> => {
    const runId = request.idempotencyKey.startsWith(prefix) ? request.idempotencyKey.slice(prefix.length) : "";
    if (!runId || request.correlationId !== runId) throw new ProviderGatewayError("AUTHORIZATION_FAILED", "Unbound Phase 7 BookAnalysis request");
    const run = await prisma.bookAnalysisRun.findUnique({ where: { id: runId }, select: { workspaceId: true, job: { select: { userId: true, workspaceId: true } } } });
    const userId = run?.job.userId;
    if (!run || !userId || run.workspaceId !== request.workspaceId || run.job.workspaceId !== request.workspaceId) throw new ProviderGatewayError("AUTHORIZATION_FAILED", "BookAnalysis durable principal provenance invalid");
    const membership = await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: request.workspaceId, userId } }, select: { userId: true } });
    if (!membership) throw new ProviderGatewayError("AUTHORIZATION_FAILED", "BookAnalysis initiator is not a workspace member");
    const key = `${request.workspaceId}:${userId}`;
    let fixture = fixtures.get(key);
    if (!fixture) { fixture = await createBookAnalysisEmbeddingGatewayFixture({ workspaceId: request.workspaceId, userId }); fixtures.set(key, fixture); }
    return fixture;
  };
  const gateway: ProviderGateway = {
    resolveSnapshot: async (request) => (await resolve(request)).embeddingGateway.gateway.resolveSnapshot(request),
    execute: async (request) => { const fixture = await resolve(request); return fixture.embeddingGateway.gateway.execute(request, { userId: fixture.embeddingGateway.userId }); },
  };
  return { gateway, repository, userId: "phase7-dynamic-resolver", close: async () => { await Promise.all([...new Set([...fixtures.keys()].map((key) => key.split(":", 1)[0]!))].map((workspaceId) => clearBookAnalysisEmbeddingGatewayFixtureState(workspaceId))); } };
}
