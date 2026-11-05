import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { afterAll, expect, it } from "vitest";
import { PostgresResourceBudget } from "../src/runtime/resource-budget.js";

afterAll(() => prisma.$disconnect());
it("serializes simultaneous reservations and releases only explicitly unstarted work", async () => {
  const workspaceId = randomUUID();
  await prisma.workspace.create({ data: { id: workspaceId, name: "budget race" } });
  try {
    await prisma.workspaceResourcePolicy.create({ data: { workspaceId, dailyUnitLimit: 5, runUnitLimit: 5 } });
    const budget = new PostgresResourceBudget();
    const request = { workspaceId, routeSlot: "BOOK_CHUNK_ANALYSIS" as const, correlationId: "run", idempotencyKey: "key", inputHash: "a".repeat(64), capability: { family: "TEXT_GENERATION" as const } };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => budget.reserve(request)));
    const success = results.filter(result => result.status === "fulfilled");
    expect(success).toHaveLength(5);
    for (const result of results.filter(result => result.status === "rejected")) expect(result.reason).toMatchObject({ code: "BUDGET_EXCEEDED" });
    const id = success[0]!.value;
    await budget.settle(id, undefined);
    await expect(budget.reserve(request)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await budget.release(id);
    await expect(budget.reserve(request)).resolves.toEqual(expect.any(String));
  } finally { await prisma.workspace.delete({ where: { id: workspaceId } }); }
});
