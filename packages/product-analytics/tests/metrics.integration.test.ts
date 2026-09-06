import { afterEach, describe, expect, it } from "vitest";
import { clearSyntheticClosedBetaCohort, clientEventSchema, computeClosedBetaMetrics, feedbackSchema, HARDCODED_KPI_OUTPUT_COUNT, PHASE17_SYNTHETIC_AS_OF, seedSyntheticClosedBetaCohort } from "../src/index.js";

afterEach(async () => { await clearSyntheticClosedBetaCohort(); });

describe("phase 17 metrics integrity synthetic cohort", () => {
  it("calculates twice from raw PostgreSQL rows with enrollment, maturity, meaningful-retention, withdrawal, and playback ordering guards", async () => {
    await seedSyntheticClosedBetaCohort();
    const first = await computeClosedBetaMetrics(PHASE17_SYNTHETIC_AS_OF);
    const second = await computeClosedBetaMetrics(PHASE17_SYNTHETIC_AS_OF);
    expect(second).toEqual(first);
    expect(HARDCODED_KPI_OUTPUT_COUNT).toBe(0);
    expect(first.enrolledParticipants).toBe(18);
    expect(first.activationWithin24hEligible).toBeLessThan(18);
    expect(first.activationWithin24hCount).toBeGreaterThan(0);
    expect(first.activationWithin24hCount).toBeLessThanOrEqual(first.activationWithin24hEligible);
    expect(first.timeToActivationMilliseconds.negativeCount).toBe(0);
    expect(first.meaningfulD1.rate).not.toBe(first.d1.rate);
    expect(first.podcast.completedPairs).toBe(2);
    expect(first.podcast.startedPairs).toBe(3);
    expect(first.podcast.naturalness.distribution[1]).toBe(0);
    expect(first.podcast.value.sampleCount).toBeGreaterThan(0);
    expect(first.thinking.startedUsers).toBeGreaterThan(0);
    expect(first.thinking.completedUsers).toBeGreaterThan(0);
    expect(first.teachBack.startedUsers).toBeGreaterThan(0);
    expect(first.teachBack.assessedUsers).toBeGreaterThan(0);
  });

  it("enforces the event and feedback entity semantics before durable writes", () => {
    const id = "1c4ccf99-2cfa-4c18-a5d1-c70a10559221";
    expect(() => clientEventSchema.parse({ eventName: "STUDIO_SESSION_STARTED", clientEventId: id, entityType: "PODCAST_AUDIO_REVISION", entityId: "cmphase17audio0000000000001" })).toThrow("EVENT_ENTITY_NOT_ALLOWED");
    expect(() => clientEventSchema.parse({ eventName: "PODCAST_PLAYBACK_STARTED", clientEventId: id })).toThrow("PLAYBACK_ENTITY_REQUIRED");
    expect(() => feedbackSchema.parse({ category: "QUALITY", dimension: "PODCAST_VALUE", rating: 5 })).toThrow("PODCAST_FEEDBACK_ENTITY_REQUIRED");
    expect(() => feedbackSchema.parse({ category: "OTHER", message: "general feedback" })).not.toThrow();
  });
});
