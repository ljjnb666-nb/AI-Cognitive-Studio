import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@ai-cognitive/db";
import { workspaceProductionDiagnostics } from "../src/production-diagnostics.js";

const workspaces: string[] = [];
afterEach(async () => { if (workspaces.length) { const ids = workspaces.splice(0); await prisma.job.deleteMany({ where: { workspaceId: { in: ids } } }); await prisma.workspace.deleteMany({ where: { id: { in: ids } } }); } });

describe("Phase 18 safe operator diagnostics", () => {
  it("does not expose another workspace or sensitive job data", async () => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@phase18.test` } });
    const a = await prisma.workspace.create({ data: { name: randomUUID() } });
    const b = await prisma.workspace.create({ data: { name: randomUUID() } });
    workspaces.push(a.id, b.id);
    await prisma.workspaceMember.create({ data: { workspaceId: a.id, userId: user.id, role: "OWNER" } });
    await prisma.job.createMany({ data: [
      { workspaceId: a.id, userId: user.id, type: "phase18.safe", status: "FAILED", payload: {}, error: { code: "sk-phase18-secret-must-never-leak" } },
      { workspaceId: a.id, userId: user.id, type: "phase18.safe", status: "FAILED", payload: {}, error: { code: "PROVIDER_TIMEOUT", message: "sk-phase18-secret-must-never-leak" } },
      { workspaceId: a.id, userId: user.id, type: "phase18.safe", status: "FAILED", payload: {}, error: { code: "UNKNOWN", detail: { authorization: "Bearer sk-phase18-secret-must-never-leak" } } },
    ] });
    await expect(workspaceProductionDiagnostics({ userId: user.id, workspaceId: b.id })).rejects.toThrow("WORKSPACE_ACCESS_DENIED");
    const diagnostics = await workspaceProductionDiagnostics({ userId: user.id, workspaceId: a.id });
    expect(JSON.stringify(diagnostics)).not.toContain("sk-phase18-secret-must-never-leak");
    expect(diagnostics.queue.failed).toBe(3);
    expect(diagnostics.jobs.map((job) => job.failureCode)).toEqual(["OPERATION_FAILED", "PROVIDER_TIMEOUT", "OPERATION_FAILED"]);
  });
});
