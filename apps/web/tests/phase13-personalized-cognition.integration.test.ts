import { describe, expect, it } from "vitest";
import { nextReviewAt, REVIEW_SCHEDULE_VERSION, reviewIntervalDays } from "../lib/cognition-review-scheduler";

describe("Phase 13 deterministic review scheduler", () => {
  it("uses the phase13-v1 interval tables and clamps the final interval", () => {
    expect(REVIEW_SCHEDULE_VERSION).toBe("phase13-v1");
    expect([0, 1, 2, 3, 4, 5, 9].map(count => reviewIntervalDays("UNASSESSED", count))).toEqual([1, 2, 4, 7, 14, 30, 30]);
    expect([0, 1, 2, 3, 4, 5, 9].map(count => reviewIntervalDays("NEEDS_REVIEW", count))).toEqual([1, 1, 2, 3, 5, 7, 7]);
    expect([0, 1, 2, 3, 4, 5, 9].map(count => reviewIntervalDays("DEVELOPING", count))).toEqual([3, 5, 7, 14, 21, 30, 30]);
    expect([0, 1, 2, 3, 4, 5, 9].map(count => reviewIntervalDays("DEMONSTRATED", count))).toEqual([7, 14, 30, 60, 90, 120, 120]);
    expect(nextReviewAt(new Date("2026-09-01T00:00:00.000Z"), "NEEDS_REVIEW", 0).toISOString()).toBe("2026-09-02T00:00:00.000Z");
  });
});
