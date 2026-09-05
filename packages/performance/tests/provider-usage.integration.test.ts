import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { afterEach, describe, expect, it } from "vitest";
import { phase16PricingCatalog, summarizePersistedProviderEfficiency } from "../src/index.js";

const workspaces: string[] = [];
afterEach(async () => { for (const workspaceId of workspaces.splice(0)) { await prisma.providerUsageEvent.deleteMany({ where: { workspaceId } }); await prisma.providerInvocationAttempt.deleteMany({ where: { workspaceId } }); await prisma.providerInvocation.deleteMany({ where: { workspaceId } }); await prisma.providerExecutionSnapshot.deleteMany({ where: { workspaceId } }); await prisma.workspace.delete({ where: { id: workspaceId } }); } });

describe("Phase 16 persisted provider usage pagination", () => {
  it("includes all 1205 eligible events rather than presenting a first page as a total", async () => {
    const workspaceId = randomUUID(), snapshotId = randomUUID(), invocationId = randomUUID(), attemptId = randomUUID(), now = new Date("2026-09-01T00:00:00.000Z"); workspaces.push(workspaceId);
    await prisma.workspace.create({ data: { id: workspaceId, name: "phase16 pagination" } });
    await prisma.providerExecutionSnapshot.create({ data: { id: snapshotId, workspaceId, routeSlot: "BENCHMARK", providerKey: "benchmark", protocol: "CUSTOM_TEXT", modelId: "text-v1", capability: { families: ["TEXT_GENERATION"] }, configurationHash: "phase16", adapterVersion: "phase16", correlationId: "phase16-pagination" } });
    await prisma.providerInvocation.create({ data: { id: invocationId, workspaceId, snapshotId, providerKey: "benchmark", protocol: "CUSTOM_TEXT", modelId: "text-v1", routeSlot: "BENCHMARK", idempotencyKey: `phase16-${workspaceId}`, requestFingerprint: "phase16", correlationId: "phase16-pagination" } });
    await prisma.providerInvocationAttempt.create({ data: { id: attemptId, workspaceId, invocationId, attemptNumber: 1, status: "SUCCEEDED" } });
    await prisma.providerUsageEvent.createMany({ data: Array.from({ length: 1_205 }, (_, index) => ({ id: randomUUID(), workspaceId, invocationId, attemptId, attemptNumber: 1, providerKey: "benchmark", modelId: "text-v1", capability: "TEXT_GENERATION", routeSlot: "BENCHMARK", status: "SUCCEEDED" as const, inputTokens: 1, createdAt: new Date(now.getTime() + index) })) });
    const summary = await summarizePersistedProviderEfficiency(phase16PricingCatalog, { workspaceId, from: new Date(now.getTime() - 1), to: new Date(now.getTime() + 2_000) }, 1_000);
    expect(summary).toMatchObject({ totalEligibleEventCount: 1_205, returnedEventCount: 1_205, truncated: false, inputTokens: 1_205 });
  });
});
