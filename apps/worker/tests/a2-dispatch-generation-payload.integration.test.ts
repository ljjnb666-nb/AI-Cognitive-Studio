import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "@ai-cognitive/db";
import { dispatchPendingBookAnalysis } from "@ai-cognitive/book-intelligence";
import { dispatchPendingPodcastGeneration } from "@ai-cognitive/podcast-generation";
import { dispatchPendingShortVideoGeneration } from "@ai-cognitive/short-video-generation";

const eventIds: string[] = [];
afterEach(async () => { await prisma.outboxEvent.deleteMany({ where: { id: { in: eventIds.splice(0) } } }); });

type Domain = { name: string; topic: string; payloadId: string; dispatch: (queue: { add(name: string, payload: { dispatchGeneration: number }, options: { jobId: string }): Promise<unknown> }) => Promise<unknown> };
const domains: Domain[] = [
  { name: "Book", topic: "a2.payload.book", payloadId: "analysisRunId", dispatch: queue => dispatchPendingBookAnalysis(queue as never, { topic: "a2.payload.book" }) },
  { name: "Podcast", topic: "a2.payload.podcast", payloadId: "podcastGenerationRunId", dispatch: queue => dispatchPendingPodcastGeneration(queue as never, { topic: "a2.payload.podcast" }) },
  { name: "Short Video", topic: "a2.payload.video", payloadId: "shortVideoGenerationRunId", dispatch: queue => dispatchPendingShortVideoGeneration(queue as never, { topic: "a2.payload.video" }) },
];
async function event(domain: Domain, generation: unknown, present = true) { const payload: Record<string, unknown> = { [domain.payloadId]: randomUUID() }; if (present) payload.dispatchGeneration = generation; const row = await prisma.outboxEvent.create({ data: { topic: domain.topic, aggregateId: randomUUID(), payload: payload as never } }); eventIds.push(row.id); return row; }

describe("A2 dispatch-generation payload contract", () => {
  for (const domain of domains) {
    it(`${domain.name} normalizes a missing generation to legacy zero`, async () => { await event(domain, undefined, false); const calls: Array<{ payload: { dispatchGeneration: number } }> = []; await domain.dispatch({ add: async (_name, payload) => { calls.push({ payload }); return {}; } }); expect(calls).toEqual([expect.objectContaining({ payload: expect.objectContaining({ dispatchGeneration: 0 }) })]); });
    it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null, true, {}, []])(`${domain.name} rejects invalid generation %#`, async value => { const row = await event(domain, value); let adds = 0; await domain.dispatch({ add: async () => { adds++; return {}; } }); const persisted = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } }); expect(adds).toBe(0); expect(persisted.status).toBe("PENDING"); expect(persisted.lastError).toContain("OUTBOX_PAYLOAD_INVALID"); });
  }
});
