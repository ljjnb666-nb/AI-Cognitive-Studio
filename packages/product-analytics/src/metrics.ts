import { prisma } from "@ai-cognitive/db";
import { METRICS_VERSION } from "./constants.js";

const HOUR = 3_600_000;
const rate = (n: number, d: number) => d ? n / d : null;
const percentile = (values: number[], fraction: number) => values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)] ?? null : null;
const inWindow = (value: Date, start: Date, end: Date) => value >= start && value < end;
const ratings = (values: number[]) => ({ sampleCount: values.length, median: percentile([...values].sort((a, b) => a - b), .5), distribution: Object.fromEntries([1, 2, 3, 4, 5].map((score) => [score, values.filter((value) => value === score).length])) });

/**
 * Computes historical cohort metrics from durable activity only. ACTIVE and
 * WITHDRAWN remain in the cohort; REMOVED is deliberately excluded. Every row
 * is bounded by enrollment, asOf, and (where applicable) withdrawal.
 */
export async function computeClosedBetaMetrics(asOf: Date) {
  const participants = await prisma.betaParticipant.findMany({ where: { status: { in: ["ACTIVE", "WITHDRAWN"] }, enrolledAt: { lte: asOf } }, select: { id: true, userId: true, cohort: true, enrolledAt: true, withdrawnAt: true, status: true } });
  const ids = participants.map((item) => item.id), userIds = participants.map((item) => item.userId);
  const [eventsRaw, intelligenceRaw, cognitionRaw, reviewRaw, thinkingRaw, teachBackRaw, feedbackRaw] = await Promise.all([
    prisma.productEvent.findMany({ where: { participantId: { in: ids }, occurredAt: { lte: asOf } }, select: { participantId: true, eventName: true, entityId: true, occurredAt: true } }),
    prisma.bookAnalysisRun.findMany({ where: { status: "SUCCEEDED", completedAt: { not: null, lte: asOf }, job: { userId: { in: userIds } } }, select: { completedAt: true, job: { select: { userId: true } } } }),
    prisma.userCognitionState.findMany({ where: { userId: { in: userIds }, state: "SAVED", createdAt: { lte: asOf } }, select: { userId: true, createdAt: true } }),
    prisma.userCognitionReviewEvent.findMany({ where: { userId: { in: userIds }, createdAt: { lte: asOf } }, select: { userId: true, createdAt: true } }),
    prisma.thinkingSession.findMany({ where: { userId: { in: userIds }, createdAt: { lte: asOf } }, select: { userId: true, createdAt: true, completedAt: true } }),
    prisma.teachBackAttempt.findMany({ where: { userId: { in: userIds }, createdAt: { lte: asOf } }, select: { userId: true, createdAt: true, assessedAt: true } }),
    prisma.betaFeedback.findMany({ where: { participantId: { in: ids }, createdAt: { lte: asOf }, rating: { not: null }, dimension: { in: ["PODCAST_NATURALNESS", "PODCAST_VALUE"] } }, select: { participantId: true, dimension: true, rating: true, createdAt: true } }),
  ]);
  const byId = new Map(participants.map((item) => [item.id, item]));
  const byUser = new Map(participants.map((item) => [item.userId, item]));
  const valid = (participant: typeof participants[number] | undefined, at: Date | null) => Boolean(participant && at && at >= participant.enrolledAt && at <= asOf && (!participant.withdrawnAt || at <= participant.withdrawnAt));
  const events = eventsRaw.filter((item) => valid(byId.get(item.participantId), item.occurredAt));
  const intelligence = intelligenceRaw.filter((item) => valid(item.job.userId ? byUser.get(item.job.userId) : undefined, item.completedAt));
  const cognitions = cognitionRaw.filter((item) => valid(byUser.get(item.userId), item.createdAt));
  const reviews = reviewRaw.filter((item) => valid(byUser.get(item.userId), item.createdAt));
  const thinking = thinkingRaw.filter((item) => valid(byUser.get(item.userId), item.createdAt));
  const teachBack = teachBackRaw.filter((item) => valid(byUser.get(item.userId), item.createdAt));
  const feedback = feedbackRaw.filter((item) => valid(byId.get(item.participantId), item.createdAt));

  const first = new Map<string, Date>();
  const earliest = (userId: string, at: Date | null) => { if (at && (!first.has(userId) || at < first.get(userId)!)) first.set(userId, at); };
  const analysis = new Map<string, Date>();
  for (const item of intelligence) if (item.job.userId && item.completedAt && (!analysis.has(item.job.userId) || item.completedAt < analysis.get(item.job.userId)!)) analysis.set(item.job.userId, item.completedAt);
  for (const item of events) if (item.eventName === "PODCAST_PLAYBACK_25") { const participant = byId.get(item.participantId); if (participant) earliest(participant.userId, item.occurredAt); }
  for (const item of cognitions) earliest(item.userId, item.createdAt);
  for (const item of thinking) if (item.completedAt && valid(byUser.get(item.userId), item.completedAt)) earliest(item.userId, item.completedAt);
  for (const item of teachBack) if (item.assessedAt && valid(byUser.get(item.userId), item.assessedAt)) earliest(item.userId, item.assessedAt);
  const activation = participants.flatMap((participant) => { const a = analysis.get(participant.userId), b = first.get(participant.userId); return a && b ? [{ participant, at: a > b ? a : b }] : []; }).filter(({ participant, at }) => at >= participant.enrolledAt);

  const sessionEvents = new Map<string, Date[]>(), meaningfulEvents = new Map<string, Date[]>();
  const add = (target: Map<string, Date[]>, id: string, at: Date) => target.set(id, [...(target.get(id) ?? []), at]);
  for (const item of events) { if (item.eventName === "STUDIO_SESSION_STARTED") add(sessionEvents, item.participantId, item.occurredAt); if (item.eventName === "PODCAST_PLAYBACK_25") add(meaningfulEvents, item.participantId, item.occurredAt); }
  for (const item of [...cognitions, ...reviews]) { const participant = byUser.get(item.userId); if (participant) add(meaningfulEvents, participant.id, item.createdAt); }
  for (const item of thinking) { const participant = byUser.get(item.userId); if (participant && item.completedAt && valid(participant, item.completedAt)) add(meaningfulEvents, participant.id, item.completedAt); }
  for (const item of teachBack) { const participant = byUser.get(item.userId); if (participant && item.assessedAt && valid(participant, item.assessedAt)) add(meaningfulEvents, participant.id, item.assessedAt); }
  const retention = (afterHours: number, source: Map<string, Date[]>) => { const eligible = activation.filter(({ at }) => at.getTime() + (afterHours + 24) * HOUR <= asOf.getTime()); const retained = eligible.filter(({ participant, at }) => (source.get(participant.id) ?? []).some((value) => inWindow(value, new Date(at.getTime() + afterHours * HOUR), new Date(at.getTime() + (afterHours + 24) * HOUR)))).length; return { eligible: eligible.length, retained, rate: rate(retained, eligible.length) }; };

  const pairs = new Map<string, { startedAt?: Date; completed: boolean }>();
  for (const item of [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())) if (item.entityId) { const key = `${item.participantId}:${item.entityId}`, current = pairs.get(key) ?? { completed: false }; if (item.eventName === "PODCAST_PLAYBACK_STARTED" && !current.startedAt) current.startedAt = item.occurredAt; if ((item.eventName === "PODCAST_PLAYBACK_90" || item.eventName === "PODCAST_PLAYBACK_ENDED") && current.startedAt && item.occurredAt >= current.startedAt) current.completed = true; pairs.set(key, current); }
  const startedPairs = [...pairs.values()].filter((item) => item.startedAt); const completedPairs = startedPairs.filter((item) => item.completed);
  const activationEligible24 = participants.filter((item) => item.enrolledAt.getTime() + 24 * HOUR <= asOf.getTime());
  const activation24 = activation.filter(({ participant, at }) => participant.enrolledAt.getTime() + 24 * HOUR <= asOf.getTime() && at <= new Date(participant.enrolledAt.getTime() + 24 * HOUR));
  const values = activation.map(({ participant, at }) => at.getTime() - participant.enrolledAt.getTime()).filter((value) => value >= 0).sort((a, b) => a - b);
  const naturalness = feedback.flatMap((item) => item.dimension === "PODCAST_NATURALNESS" && item.rating ? [item.rating] : []); const value = feedback.flatMap((item) => item.dimension === "PODCAST_VALUE" && item.rating ? [item.rating] : []);
  const cohort = Object.fromEntries([...new Set(participants.map((item) => item.cohort))].sort().map((name) => { const enrolled = participants.filter((item) => item.cohort === name).length, activated = activation.filter(({ participant }) => participant.cohort === name).length; return [name, { enrolled, activated, activationRate: rate(activated, enrolled) }]; }));
  return { metricsVersion: METRICS_VERSION, asOf: asOf.toISOString(), cohortSemantics: "ACTIVE and WITHDRAWN are retained in historical cohorts; activity after withdrawnAt and REMOVED participants are excluded.", enrolledParticipants: participants.length, activatedParticipants: activation.length, activationRate: rate(activation.length, participants.length), activationWithin24hEligible: activationEligible24.length, activationWithin24hCount: activation24.length, activationWithin24hRate: rate(activation24.length, activationEligible24.length), activationByCohort: cohort, timeToActivationMilliseconds: { p50: percentile(values, .5), p95: percentile(values, .95), sampleCount: values.length, negativeCount: activation.length - values.length }, d1: retention(24, sessionEvents), d7: retention(168, sessionEvents), meaningfulD1: retention(24, meaningfulEvents), meaningfulD7: retention(168, meaningfulEvents), podcast: { startedPairs: startedPairs.length, completedPairs: completedPairs.length, completionRate: rate(completedPairs.length, startedPairs.length), naturalness: ratings(naturalness), value: ratings(value) }, cognition: { saveUsers: new Set(cognitions.map((item) => item.userId)).size, reviewUsers: new Set(reviews.map((item) => item.userId)).size }, thinking: { startedUsers: new Set(thinking.map((item) => item.userId)).size, completedUsers: new Set(thinking.filter((item) => item.completedAt && valid(byUser.get(item.userId), item.completedAt)).map((item) => item.userId)).size }, teachBack: { startedUsers: new Set(teachBack.map((item) => item.userId)).size, assessedUsers: new Set(teachBack.filter((item) => item.assessedAt && valid(byUser.get(item.userId), item.assessedAt)).map((item) => item.userId)).size }, unattributed: { excludedEvents: eventsRaw.length - events.length, note: "Pre-enrollment, post-withdrawal, and non-cohort activity is excluded." } };
}
