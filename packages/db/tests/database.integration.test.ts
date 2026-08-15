import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStatus, prisma } from "../src/index.js";

const fixtureJobKeys = ["user-job-key", "system-health-check-key"];
const fixtureUserEmails = ["phase0@example.test"];

async function cleanupFixtures() {
  await prisma.job.deleteMany({ where: { idempotencyKey: { in: fixtureJobKeys } } });
  await prisma.user.deleteMany({ where: { email: { in: fixtureUserEmails } } });
}

beforeEach(cleanupFixtures);
afterEach(cleanupFixtures);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("database integration", () => {
  it("creates, updates, and reads a User with its Job", async () => {
    const user = await prisma.user.create({
      data: { email: "phase0@example.test", name: "Phase Zero" },
    });
    const job = await prisma.job.create({
      data: {
        userId: user.id,
        type: "system.health-check",
        payload: { message: "phase-0" },
        idempotencyKey: "user-job-key",
      },
    });

    const updated = await prisma.job.update({
      where: { id: job.id },
      data: { status: JobStatus.SUCCEEDED, progress: 100, result: { ok: true }, attemptCount: 1 },
      include: { user: true },
    });

    expect(updated.status).toBe(JobStatus.SUCCEEDED);
    expect(updated.user).toMatchObject({ email: "phase0@example.test" });
    expect(updated.result).toEqual({ ok: true });
    expect(updated.attemptCount).toBe(1);
  });

  it("supports a system job and rejects a duplicate idempotency key", async () => {
    await prisma.job.create({
      data: {
        type: "system.health-check",
        payload: { message: "phase-0" },
        idempotencyKey: "system-health-check-key",
      },
    });

    await expect(
      prisma.job.create({
        data: {
          type: "system.health-check",
          payload: { message: "phase-0" },
          idempotencyKey: "system-health-check-key",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const systemJob = await prisma.job.findUniqueOrThrow({ where: { idempotencyKey: "system-health-check-key" } });
    expect(systemJob.userId).toBeNull();
    expect(systemJob.workspaceId).toBeNull();
  });
});
