import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { BOOK_ANALYSIS_BOOTSTRAP_TOPIC } from "@ai-cognitive/ingestion";
import { readEnvironment } from "@ai-cognitive/shared/server";
import { bookAnalysisBootstrapJobId, createBookAnalysisBootstrapQueue, dispatchBookAnalysisBootstrapWithQueue, type BookAnalysisBootstrapPayload } from "../src/book-analysis-bootstrap.js";

const ownedEventIds: string[] = [];
const ownedQueues: ReturnType<typeof createBookAnalysisBootstrapQueue>[] = [];

async function createEvent(aggregateId: string, dispatchGeneration: number) {
  const event = await prisma.outboxEvent.create({ data: {
    topic: BOOK_ANALYSIS_BOOTSTRAP_TOPIC,
    aggregateId,
    payload: { bootstrapId: aggregateId, dispatchGeneration } satisfies BookAnalysisBootstrapPayload,
  } });
  ownedEventIds.push(event.id);
  return event;
}

afterEach(async () => {
  await Promise.all(ownedQueues.splice(0).map(async queue => {
    await queue.obliterate({ force: true });
    await queue.close();
  }));
  await prisma.outboxEvent.deleteMany({ where: { id: { in: ownedEventIds.splice(0) } } });
});

afterAll(() => prisma.$disconnect());

describe("BookAnalysisBootstrap production outbox dispatch", () => {
  it("enqueues one valid deterministic job and preserves duplicate and exact-target semantics", async () => {
    const suffix = randomUUID();
    const bootstrapId = `bootstrap-${suffix}`;
    const nonTargetBootstrapId = `bootstrap-non-target-${suffix}`;
    const target = await createEvent(bootstrapId, 1);
    const nonTarget = await createEvent(nonTargetBootstrapId, 1);
    const queue = createBookAnalysisBootstrapQueue(readEnvironment(), { prefix: `book-bootstrap-job-id-${suffix}` });
    ownedQueues.push(queue);
    const expectedJobId = bookAnalysisBootstrapJobId({ bootstrapId, dispatchGeneration: 1 });

    expect(expectedJobId).toBe(`book-analysis-bootstrap-${bootstrapId}-g1`);
    expect(expectedJobId).not.toContain(":");
    expect(expectedJobId).not.toMatch(/^\d+$/);

    expect(await dispatchBookAnalysisBootstrapWithQueue(queue, { aggregateIds: [bootstrapId], batchSize: 1 })).toBe(1);
    const job = await queue.getJob(expectedJobId);
    expect(job).toMatchObject({ id: expectedJobId, name: "book.analysis.bootstrap", data: { bootstrapId, dispatchGeneration: 1 } });
    expect(await job?.getState()).toBe("waiting");
    expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: "DISPATCHED", attemptCount: 1 });
    expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: nonTarget.id } })).toMatchObject({ status: "PENDING", attemptCount: 0 });

    expect(await dispatchBookAnalysisBootstrapWithQueue(queue, { aggregateIds: [bootstrapId], batchSize: 1 })).toBe(0);
    expect(await queue.getWaitingCount()).toBe(1);
  });
});
