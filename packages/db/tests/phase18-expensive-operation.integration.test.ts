import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { admitWorkspaceExpensiveOperation } from "../src/expensive-operations.js";
import { prisma } from "../src/index.js";

const workspaces: string[] = [];
afterEach(async () => { if (workspaces.length) { const ids = workspaces.splice(0); await prisma.job.deleteMany({ where: { workspaceId: { in: ids } } }); await prisma.workspace.deleteMany({ where: { id: { in: ids } } }); } });

describe("Phase 18 workspace expensive-operation admission", () => {
  it("serializes concurrent admissions in real PostgreSQL without cross-workspace interference", async () => {
    const a = await prisma.workspace.create({ data: { name: randomUUID() } });
    const b = await prisma.workspace.create({ data: { name: randomUUID() } });
    workspaces.push(a.id, b.id);
    await prisma.job.create({ data: { workspaceId: a.id, type: "source.ingest", payload: {} } });
    const request = (workspaceId: string, marker: string) => prisma.$transaction(async (tx) => {
      await admitWorkspaceExpensiveOperation(tx, workspaceId, 2);
      return tx.job.create({ data: { workspaceId, type: "book.analysis", idempotencyKey: `${workspaceId}:${marker}`, payload: {} } });
    });
    const results = await Promise.allSettled([request(a.id, "one"), request(a.id, "two"), request(a.id, "three"), request(b.id, "one")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.message)).toEqual(["WORKSPACE_EXPENSIVE_OPERATION_LIMIT_REACHED"]);
    expect(await prisma.job.count({ where: { workspaceId: a.id } })).toBe(3);
    expect(await prisma.job.count({ where: { workspaceId: b.id } })).toBe(1);
  });
});
