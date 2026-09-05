import { prisma } from "@ai-cognitive/db";
import { METRICS_VERSION } from "./constants.js";

const HOUR = 3_600_000;
const rate = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
const percentile = (values: number[], fraction: number) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? null : null;
const ratingSummary = (ratings: number[]) => ({ sampleCount: ratings.length, median: percentile([...ratings].sort((a, b) => a - b), .5), distribution: Object.fromEntries([1, 2, 3, 4, 5].map((rating) => [rating, ratings.filter((value) => value === rating).length])) });
const inWindow = (value: Date, start: Date, end: Date) => value >= start && value < end;

/** All windows are explicit and reproducible from `asOf`; no metric quietly reads the current time. */
export async function computeClosedBetaMetrics(asOf: Date) {
  const participants = await prisma.betaParticipant.findMany({ where: { status: "ACTIVE", enrolledAt: { lte: asOf } }, select: { id: true, userId: true, enrolledAt: true, cohort: true } });
  const ids = participants.map((participant) => participant.id);
  const userIds = participants.map((participant) => participant.userId);
  const [events, intelligence, cognitions, reviews, thinking, teachBack, feedback] = await Promise.all([
    prisma.productEvent.findMany({ where: { participantId: { in: ids }, occurredAt: { lte: asOf } }, select: { participantId: true, eventName: true, entityId: true, occurredAt: true } }),
    prisma.bookAnalysisRun.findMany({ where: { status: "SUCCEEDED", completedAt: { not: null, lte: asOf }, job: { userId: { in: userIds } } }, select: { completedAt: true, job: { select: { userId: true } } } }),
    prisma.userCognitionState.findMany({ where: { userId: { in: userIds }, state: "SAVED", createdAt: { lte: asOf } }, select: { userId: true, createdAt: true } }),
    prisma.userCognitionReviewEvent.findMany({ where: { userId: { in: userIds }, createdAt: { lte: asOf } }, select: { userId: true, createdAt: true } }),
    prisma.thinkingSession.findMany({ where: { userId: { in: userIds }, createdAt: { lte: asOf } }, select: { userId: true, createdAt: true, completedAt: true } }),
    prisma.teachBackAttempt.findMany({ where: { userId: { in: userIds }, createdAt: { lte: asOf } }, select: { userId: true, createdAt: true, assessedAt: true } }),
    prisma.betaFeedback.findMany({ where: { participantId: { in: ids }, createdAt: { lte: asOf }, rating: { not: null }, dimension: { in: ["PODCAST_NATURALNESS", "PODCAST_VALUE"] } }, select: { dimension: true, rating: true } }),
  ]);

  const participantFor = new Map(participants.map((participant) => [participant.id, participant]));
  const firstValueAt = new Map<string, Date>();
  const recordFirstValue = (userId: string, at: Date | null) => { if (at && (!firstValueAt.has(userId) || at < firstValueAt.get(userId)!)) firstValueAt.set(userId, at); };
  const intelligenceAt = new Map<string, Date>();
  for (const item of intelligence) if (item.job.userId && item.completedAt && (!intelligenceAt.has(item.job.userId) || item.completedAt < intelligenceAt.get(item.job.userId)!)) intelligenceAt.set(item.job.userId, item.completedAt);
  for (const event of events) if (event.eventName === "PODCAST_PLAYBACK_25") { const participant = participantFor.get(event.participantId); if (participant) recordFirstValue(participant.userId, event.occurredAt); }
  for (const item of cognitions) recordFirstValue(item.userId, item.createdAt);
  for (const item of thinking) recordFirstValue(item.userId, item.completedAt);
  for (const item of teachBack) recordFirstValue(item.userId, item.assessedAt);
  // Activation requires safely attributed analysis plus a distinct value action.
  const activation = participants.flatMap((participant) => {
    const analysis = intelligenceAt.get(participant.userId), value = firstValueAt.get(participant.userId);
    return analysis && value ? [{ participant, at: analysis > value ? analysis : value }] : [];
  });
  const sessions = new Map<string, Date[]>();
  for (const event of events) if (event.eventName === "STUDIO_SESSION_STARTED") sessions.set(event.participantId, [...(sessions.get(event.participantId) ?? []), event.occurredAt]);
  const retention = (afterHours: number) => {
    const mature = activation.filter(({ at }) => at.getTime() + (afterHours + 24) * HOUR <= asOf.getTime());
    const retained = mature.filter(({ participant, at }) => (sessions.get(participant.id) ?? []).some((occurredAt) => inWindow(occurredAt, new Date(at.getTime() + afterHours * HOUR), new Date(at.getTime() + (afterHours + 24) * HOUR)))).length;
    return { eligible: mature.length, retained, rate: rate(retained, mature.length), windowHours: [afterHours, afterHours + 24] as const };
  };
  const playback = new Map<string, { started: boolean; complete: boolean }>();
  for (const event of events) if (event.entityId) {
    const key = `${event.participantId}:${event.entityId}`;
    const value = playback.get(key) ?? { started: false, complete: false };
    if (event.eventName === "PODCAST_PLAYBACK_STARTED") value.started = true;
    if (event.eventName === "PODCAST_PLAYBACK_90" || event.eventName === "PODCAST_PLAYBACK_ENDED") value.complete = true;
    playback.set(key, value);
  }
  const startedPairs = [...playback.values()].filter((item) => item.started);
  const completedPairs = startedPairs.filter((item) => item.complete);
  const times = activation.map(({ participant, at }) => at.getTime() - participant.enrolledAt.getTime()).sort((a, b) => a - b);
  const naturalness = feedback.flatMap((item) => item.dimension === "PODCAST_NATURALNESS" && item.rating ? [item.rating] : []);
  const value = feedback.flatMap((item) => item.dimension === "PODCAST_VALUE" && item.rating ? [item.rating] : []);
  const activationByCohort = Object.fromEntries([...new Set(participants.map((item) => item.cohort))].sort().map((cohort) => {
    const enrolled = participants.filter((item) => item.cohort === cohort).length;
    const activated = activation.filter(({ participant }) => participant.cohort === cohort).length;
    return [cohort, { enrolled, activated, activationRate: rate(activated, enrolled) }];
  }));
  const activationWithin24Hours = activation.filter(({ participant, at }) => at.getTime() - participant.enrolledAt.getTime() <= 24 * HOUR).length;
  return {
    metricsVersion: METRICS_VERSION,
    asOf: asOf.toISOString(),
    metricDefinitions: { activation: "attributed successful Book Intelligence plus a first value action; timestamp is the later of the two", d1: "session in [activation+24h, activation+48h), mature only", d7: "session in [activation+168h, activation+192h), mature only", podcastCompletion: "same participant/audio pair emitted start and then 90 percent or ended" },
    enrolledParticipants: participants.length,
    activatedParticipants: activation.length,
    activationRate: rate(activation.length, participants.length),
    activationWithin24Hours: { activated: activationWithin24Hours, rate: rate(activationWithin24Hours, participants.length) },
    activationByCohort,
    timeToActivationMilliseconds: { p50: percentile(times, .5), p95: percentile(times, .95), sampleCount: times.length },
    d1: retention(24),
    d7: retention(168),
    meaningfulRetention: retention(24),
    podcast: { startedPairs: startedPairs.length, completedPairs: completedPairs.length, completionRate: rate(completedPairs.length, startedPairs.length), naturalness: ratingSummary(naturalness), value: ratingSummary(value) },
    cognition: { saveUsers: new Set(cognitions.map((item) => item.userId)).size, reviewUsers: new Set(reviews.map((item) => item.userId)).size, reviewRateAmongSavers: rate(new Set(reviews.map((item) => item.userId)).size, new Set(cognitions.map((item) => item.userId)).size) },
    thinking: { startedUsers: new Set(thinking.map((item) => item.userId)).size, completedUsers: new Set(thinking.filter((item) => item.completedAt).map((item) => item.userId)).size, completionRate: rate(new Set(thinking.filter((item) => item.completedAt).map((item) => item.userId)).size, new Set(thinking.map((item) => item.userId)).size) },
    teachBack: { startedUsers: new Set(teachBack.map((item) => item.userId)).size, assessedUsers: new Set(teachBack.filter((item) => item.assessedAt).map((item) => item.userId)).size, assessmentRate: rate(new Set(teachBack.filter((item) => item.assessedAt).map((item) => item.userId)).size, new Set(teachBack.map((item) => item.userId)).size) },
    unattributed: { excludedEvents: 0, note: "ProductEvent requires durable participant, user, and workspace identity; unattributed rows are not persisted." },
  };
}
