import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { ProviderGatewayRepository, testCipher } from "@ai-cognitive/provider-gateway";
import { providerReadiness } from "../lib/provider-product.js";
import { readinessDisplay } from "../lib/provider-readiness-ui.js";

const owned: Array<{ workspaceId: string; userId: string }> = [];
const manifest = JSON.stringify({ providers: [
  { providerKey: "minimax", displayName: "MiniMax", protocol: "OPENAI_COMPATIBLE", adapterVersion: "test", models: [{ modelId: "MiniMax-M3", families: ["TEXT_GENERATION"], confidence: "DECLARED", structuredOutput: "JSON_MODE" }] },
  { providerKey: "gemini", displayName: "Google Gemini", protocol: "GEMINI_NATIVE", capabilityProtocols: { EMBEDDING: "GEMINI_EMBEDDINGS" }, adapterVersion: "test", models: [{ modelId: "gemini-embedding-2", families: ["EMBEDDING"], confidence: "DECLARED", embeddingDimensions: 768, configurableEmbeddingDimensions: true, embeddingDimensionOptions: [768] }] },
] });

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID();
  owned.push({ workspaceId, userId });
  await prisma.workspace.create({ data: { id: workspaceId, name: `readiness-${workspaceId}` } });
  await prisma.user.create({ data: { id: userId, email: `${userId}@test.invalid` } });
  await prisma.workspaceMember.create({ data: { workspaceId, userId, role: "OWNER" } });
  const repository = new ProviderGatewayRepository(prisma, testCipher()), identity = { workspaceId, userId };
  const minimax = await repository.createConnection(identity, { providerKey: "minimax", protocol: "OPENAI_COMPATIBLE", displayName: "MiniMax", endpoint: "https://api.minimax.io/v1/text/chatcompletion_v2" });
  await repository.rotateCredential(identity, minimax.id, "minimax-readiness-test-secret");
  for (const routeSlot of ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "THINKING_SESSION", "TEACH_BACK_ASSESSMENT"] as const) await repository.setRoute(identity, { routeSlot, connectionId: minimax.id, modelId: "MiniMax-M3" });
  return { workspaceId, identity, repository };
}

afterEach(async () => {
  for (const { workspaceId, userId } of owned.splice(0)) {
    await prisma.providerRouteBinding.deleteMany({ where: { workspaceId } });
    await prisma.providerCredentialVersion.deleteMany({ where: { workspaceId } });
    await prisma.providerConnection.deleteMany({ where: { workspaceId } });
    await prisma.providerAuditEvent.deleteMany({ where: { workspaceId } });
    await prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
  }
  delete process.env.PROVIDER_GATEWAY_MODEL_MANIFEST;
});

describe("Provider settings Book readiness", () => {
  it("shows exactly the missing embedding while preserving MiniMax Book and Thinking routes", async () => {
    process.env.PROVIDER_GATEWAY_MODEL_MANIFEST = manifest;
    const data = await fixture(), readiness = await providerReadiness(data.workspaceId), display = readinessDisplay(readiness.book);
    expect(readiness.book).toMatchObject({ state: "INCOMPLETE", configured: 3, required: 4, missing: ["BOOK_EMBEDDING_PROVIDER_NOT_CONFIGURED"] });
    expect(readiness.book.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot: "BOOK_CHUNK_ANALYSIS", state: "READY", providerName: "MiniMax", modelId: "MiniMax-M3" }),
      expect.objectContaining({ slot: "BOOK_REDUCTION_ANALYSIS", state: "READY", providerName: "MiniMax", modelId: "MiniMax-M3" }),
      expect.objectContaining({ slot: "BOOK_SYNTHESIS", state: "READY", providerName: "MiniMax", modelId: "MiniMax-M3" }),
      expect.objectContaining({ slot: "EMBEDDING", state: "MISSING", error: "BOOK_EMBEDDING_PROVIDER_NOT_CONFIGURED" }),
    ]));
    expect(display).toMatchObject({ summary: "3 / 4 已配置", completion: "待完成 1 项", rows: expect.arrayContaining([expect.objectContaining({ label: "分块理解", configured: true, detail: "MiniMax · MiniMax-M3" }), expect.objectContaining({ label: "向量检索", configured: false, detail: "尚未配置｜请选择兼容的向量模型与维度" })]) });
    expect(readiness.thinking).toMatchObject({ state: "READY", dependencies: [expect.objectContaining({ providerName: "MiniMax", modelId: "MiniMax-M3" })] });
    expect(readiness.mastery.state).toBe("INCOMPLETE");
  });

  it("reaches four of four only after an executable Gemini 768 embedding route is bound", async () => {
    process.env.PROVIDER_GATEWAY_MODEL_MANIFEST = manifest;
    const data = await fixture();
    const gemini = await data.repository.createConnection(data.identity, { providerKey: "gemini", protocol: "GEMINI_EMBEDDINGS", displayName: "Gemini", endpoint: "https://generativelanguage.googleapis.com/v1beta" });
    await data.repository.rotateCredential(data.identity, gemini.id, "gemini-readiness-test-secret");
    await data.repository.setRoute(data.identity, { routeSlot: "EMBEDDING", connectionId: gemini.id, modelId: "gemini-embedding-2", configuration: { embeddingDimensions: 768 } });
    const readiness = await providerReadiness(data.workspaceId), display = readinessDisplay(readiness.book);
    expect(readiness.book).toMatchObject({ state: "READY", configured: 4, required: 4, missing: [] });
    expect(readiness.book.dependencies).toContainEqual(expect.objectContaining({ slot: "EMBEDDING", state: "READY", providerName: "Google Gemini", modelId: "gemini-embedding-2" }));
    expect(display).toMatchObject({ summary: "4 / 4 已配置", completion: "已就绪", rows: expect.arrayContaining([expect.objectContaining({ label: "向量检索", configured: true, detail: "Google Gemini · gemini-embedding-2" })]) });
  });
});
