export const REVIEW_SCHEDULE_VERSION = "phase13-v1";
export type TeachBackMasteryState = "NEEDS_REVIEW" | "DEVELOPING" | "DEMONSTRATED";
export type ReviewMasteryState = TeachBackMasteryState | "UNASSESSED";

const intervals: Record<ReviewMasteryState, readonly number[]> = {
  UNASSESSED: [1, 2, 4, 7, 14, 30],
  NEEDS_REVIEW: [1, 1, 2, 3, 5, 7],
  DEVELOPING: [3, 5, 7, 14, 21, 30],
  DEMONSTRATED: [7, 14, 30, 60, 90, 120],
};

export function reviewIntervalDays(mastery: ReviewMasteryState, reviewCount: number): number {
  const schedule = intervals[mastery];
  return schedule[Math.min(Math.max(0, reviewCount), schedule.length - 1)]!;
}

export function nextReviewAt(from: Date, mastery: ReviewMasteryState, reviewCount: number): Date {
  return new Date(from.getTime() + reviewIntervalDays(mastery, reviewCount) * 86_400_000);
}
