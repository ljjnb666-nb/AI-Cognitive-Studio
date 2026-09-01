import { Prisma, prisma } from "@ai-cognitive/db";
import type { WebIdentityContext } from "./identity";
import { currentLineageJoin, isCognitionType, type CognitionType } from "./cognitions";
import { nextReviewAt, REVIEW_SCHEDULE_VERSION, type ReviewMasteryState, type TeachBackMasteryState } from "./cognition-review-scheduler";

type Identity = Pick<WebIdentityContext, "workspaceId" | "userId">;
type CorpusRow = { id: string; type: CognitionType; content: string; sourceDocumentId: string; sourceTitle: string; createdAt: Date; masteryState: TeachBackMasteryState | null; assessedAt: Date | null; reviewCount: number | null; lastReviewedAt: Date | null; nextReviewAt: Date | null; cachedMasteryState: TeachBackMasteryState | null; cachedMasteryAssessedAt: Date | null };
export type PersonalCognition = Omit<CorpusRow, "masteryState" | "createdAt" | "assessedAt" | "lastReviewedAt" | "nextReviewAt" | "cachedMasteryState" | "cachedMasteryAssessedAt"> & { masteryState: ReviewMasteryState; createdAt: string; assessedAt: string | null; lastReviewedAt: string | null; nextReviewAt: string | null };

function corpusQuery(identity: Identity) {
  return Prisma.sql`
    SELECT memory."id", memory."type", memory."content", memory."sourceDocumentId", memory."createdAt", source."displayName" AS "sourceTitle",
      assessment."masteryState", attempt."assessedAt", review."reviewCount", review."lastReviewedAt", review."nextReviewAt",
      review."lastMasteryState" AS "cachedMasteryState", review."lastMasteryAssessedAt" AS "cachedMasteryAssessedAt"
    FROM "BookMemoryItem" memory
    ${currentLineageJoin()}
    LEFT JOIN "UserCognitionState" state ON state."workspaceId"=memory."workspaceId" AND state."userId"=${identity.userId} AND state."memoryItemId"=memory."id"
    LEFT JOIN LATERAL (
      SELECT * FROM "TeachBackAttempt" candidate WHERE candidate."workspaceId"=memory."workspaceId" AND candidate."userId"=${identity.userId} AND candidate."memoryItemId"=memory."id" AND candidate."status"='ASSESSED'::"TeachBackAttemptStatus"
      ORDER BY candidate."assessedAt" DESC, candidate."id" DESC LIMIT 1
    ) attempt ON true
    LEFT JOIN "TeachBackAssessment" assessment ON assessment."workspaceId"=memory."workspaceId" AND assessment."attemptId"=attempt."id"
    LEFT JOIN "UserCognitionReviewState" review ON review."workspaceId"=memory."workspaceId" AND review."userId"=${identity.userId} AND review."memoryItemId"=memory."id"
    WHERE memory."workspaceId"=${identity.workspaceId} AND run."status"='SUCCEEDED'::"AnalysisRunStatus"
      AND memory."type" IN ('SUMMARY'::"BookMemoryItemType",'CONCEPT'::"BookMemoryItemType",'ARGUMENT'::"BookMemoryItemType",'CLAIM'::"BookMemoryItemType",'COUNTERPOINT'::"BookMemoryItemType",'QUOTE'::"BookMemoryItemType",'QUESTION'::"BookMemoryItemType",'EXAMPLE'::"BookMemoryItemType",'STORY'::"BookMemoryItemType")
      AND (state."id" IS NULL OR state."state"<>'ARCHIVED'::"UserCognitionStateKind")
      AND (state."state"='SAVED'::"UserCognitionStateKind" OR EXISTS (SELECT 1 FROM "ThinkingSession" session WHERE session."workspaceId"=memory."workspaceId" AND session."userId"=${identity.userId} AND session."memoryItemId"=memory."id") OR EXISTS (SELECT 1 FROM "TeachBackAttempt" teach WHERE teach."workspaceId"=memory."workspaceId" AND teach."userId"=${identity.userId} AND teach."memoryItemId"=memory."id"))
  `;
}

async function corpusRows(identity: Identity): Promise<CorpusRow[]> { return prisma.$queryRaw<CorpusRow[]>(corpusQuery(identity)); }
function mastery(row: CorpusRow): ReviewMasteryState { return row.masteryState ?? "UNASSESSED"; }
function serialize(row: CorpusRow): PersonalCognition { return { id: row.id, type: row.type, content: row.content, sourceDocumentId: row.sourceDocumentId, sourceTitle: row.sourceTitle, masteryState: mastery(row), reviewCount: row.reviewCount ?? 0, createdAt: row.createdAt.toISOString(), assessedAt: row.assessedAt?.toISOString() ?? null, lastReviewedAt: row.lastReviewedAt?.toISOString() ?? null, nextReviewAt: row.nextReviewAt?.toISOString() ?? null }; }

export async function getPersonalCognitionCorpus(identity: Identity) { return (await corpusRows(identity)).filter(row => isCognitionType(row.type)).map(serialize); }

export async function getPersonalCognitionOverview(identity: Identity) {
  const rows = await corpusRows(identity), now = new Date();
  const counts = { total: rows.length, saved: 0, withThinking: 0, withTeachBack: 0, unassessed: 0, needsReview: 0, developing: 0, demonstrated: 0, dueNow: 0 };
  // Interaction flags are independently scoped; do not infer them from a shared cognition.
  const ids = rows.map(row => row.id);
  const [states, sessions, attempts] = await Promise.all([
    prisma.userCognitionState.findMany({ where: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: { in: ids }, state: "SAVED" }, select: { memoryItemId: true } }),
    prisma.thinkingSession.findMany({ where: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: { in: ids } }, distinct: ["memoryItemId"], select: { memoryItemId: true } }),
    prisma.teachBackAttempt.findMany({ where: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: { in: ids } }, distinct: ["memoryItemId"], select: { memoryItemId: true } }),
  ]);
  counts.saved = states.length; counts.withThinking = sessions.length; counts.withTeachBack = attempts.length;
  for (const row of rows) { const value = mastery(row); if (value === "UNASSESSED") counts.unassessed++; else if (value === "NEEDS_REVIEW") counts.needsReview++; else if (value === "DEVELOPING") counts.developing++; else counts.demonstrated++; const due = row.nextReviewAt ?? nextReviewAt(row.assessedAt ?? row.createdAt, value, row.reviewCount ?? 0); if (due <= now) counts.dueNow++; }
  return counts;
}

type Rubric = Array<{ key?: unknown; status?: unknown }>;
export async function getPersonalWeakPoints(identity: Identity) {
  const rows = await corpusRows(identity), weak = rows.filter(row => mastery(row) === "NEEDS_REVIEW" || mastery(row) === "DEVELOPING");
  const assessedIds = rows.filter(row => row.masteryState).map(row => row.id);
  const assessments = assessedIds.length ? await prisma.$queryRaw<Array<{ memoryItemId: string; rubric: unknown }>>(Prisma.sql`SELECT DISTINCT ON (attempt."memoryItemId") attempt."memoryItemId", assessment."rubric" FROM "TeachBackAttempt" attempt JOIN "TeachBackAssessment" assessment ON assessment."attemptId"=attempt."id" AND assessment."workspaceId"=attempt."workspaceId" WHERE attempt."workspaceId"=${identity.workspaceId} AND attempt."userId"=${identity.userId} AND attempt."status"='ASSESSED'::"TeachBackAttemptStatus" AND attempt."memoryItemId" IN (${Prisma.join(assessedIds)}) ORDER BY attempt."memoryItemId", attempt."assessedAt" DESC, attempt."id" DESC`) : [];
  const aggregate = new Map<string, { criterionKey: string; notMetCount: number; partialCount: number; affected: Set<string> }>();
  for (const row of assessments) if (Array.isArray(row.rubric)) for (const item of row.rubric as Rubric) if (typeof item.key === "string" && (item.status === "NOT_MET" || item.status === "PARTIAL")) { const value = aggregate.get(item.key) ?? { criterionKey: item.key, notMetCount: 0, partialCount: 0, affected: new Set<string>() }; if (item.status === "NOT_MET") value.notMetCount++; else value.partialCount++; value.affected.add(row.memoryItemId); aggregate.set(item.key, value); }
  return { weak: weak.map(serialize), unassessed: rows.filter(row => mastery(row) === "UNASSESSED").map(serialize), criteria: [...aggregate.values()].map(value => ({ criterionKey: value.criterionKey, notMetCount: value.notMetCount, partialCount: value.partialCount, affectedCognitionCount: value.affected.size })).sort((a, b) => b.notMetCount - a.notMetCount || b.partialCount - a.partialCount || a.criterionKey.localeCompare(b.criterionKey)) };
}

export type RecommendationReason = "WEAK_MASTERY" | "DEVELOPING_MASTERY" | "UNASSESSED" | "OVERDUE" | "MAINTAIN_MASTERY" | "REVIEW_SOON";
export async function getRecommendedReviews(identity: Identity, limit = 5) {
  const now = new Date(), rows = await corpusRows(identity);
  const decorated = rows.map(row => { const state = mastery(row), due = row.nextReviewAt ?? nextReviewAt(row.assessedAt ?? row.createdAt, state, row.reviewCount ?? 0), overdue = due <= now; const bucket = overdue ? state === "NEEDS_REVIEW" ? 0 : state === "DEVELOPING" ? 1 : state === "UNASSESSED" ? 2 : 3 : 4; const reason: RecommendationReason = overdue ? state === "NEEDS_REVIEW" ? "WEAK_MASTERY" : state === "DEVELOPING" ? "DEVELOPING_MASTERY" : state === "UNASSESSED" ? "UNASSESSED" : "MAINTAIN_MASTERY" : "REVIEW_SOON"; return { ...serialize(row), dueAt: due.toISOString(), overdue, reason, bucket, due, lastReviewed: row.lastReviewedAt?.getTime() ?? 0, lastAssessed: row.assessedAt?.getTime() ?? 0 }; }).sort((a, b) => a.bucket - b.bucket || a.due.getTime() - b.due.getTime() || a.lastReviewed - b.lastReviewed || a.lastAssessed - b.lastAssessed || a.id.localeCompare(b.id));
  const selected: typeof decorated = [], deferred: typeof decorated = [], perSource = new Map<string, number>();
  for (const item of decorated) { if (selected.length >= limit) break; const count = perSource.get(item.sourceDocumentId) ?? 0; if (count < 2) { selected.push(item); perSource.set(item.sourceDocumentId, count + 1); } else deferred.push(item); }
  for (const item of deferred) if (selected.length < limit) selected.push(item);
  return selected.map(({ bucket, due, lastReviewed, lastAssessed, ...item }) => item);
}

export async function isActivePersonalCognition(identity: Identity, memoryItemId: string, client: typeof prisma = prisma) {
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT corpus."id" FROM (${corpusQuery(identity)}) corpus WHERE corpus."id"=${memoryItemId} LIMIT 1`);
  return Boolean(rows[0]);
}

export async function recordManualCognitionReview(identity: Identity, input: { memoryItemId: string; eventId: string }) {
  const at = new Date();
  return prisma.$transaction(async tx => {
    if (!(await isActivePersonalCognition(identity, input.memoryItemId, tx as typeof prisma))) throw new Error("COGNITION_NOT_FOUND");
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.eventId}, 0))`);
    const existing = await tx.userCognitionReviewEvent.findFirst({ where: { id: input.eventId, workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: input.memoryItemId } });
    if (existing) return { idempotent: true, eventId: existing.id };
    const latest = await tx.teachBackAttempt.findFirst({ where: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: input.memoryItemId, status: "ASSESSED" }, include: { assessment: true }, orderBy: [{ assessedAt: "desc" }, { id: "desc" }] });
    const state = latest?.assessment?.masteryState ?? "UNASSESSED";
    const prior = await tx.userCognitionReviewState.findUnique({ where: { workspaceId_userId_memoryItemId: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: input.memoryItemId } } });
    const reviewCount = (prior?.reviewCount ?? 0) + 1;
    await tx.userCognitionReviewEvent.create({ data: { id: input.eventId, workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: input.memoryItemId, kind: "MANUAL_REVIEW" } });
    await tx.userCognitionReviewState.upsert({ where: { workspaceId_userId_memoryItemId: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: input.memoryItemId } }, create: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: input.memoryItemId, reviewCount, lastReviewedAt: at, nextReviewAt: nextReviewAt(at, state, reviewCount), lastMasteryState: latest?.assessment?.masteryState, lastMasteryAssessedAt: latest?.assessedAt, scheduleVersion: REVIEW_SCHEDULE_VERSION }, update: { reviewCount, lastReviewedAt: at, nextReviewAt: nextReviewAt(at, state, reviewCount), lastMasteryState: latest?.assessment?.masteryState ?? undefined, lastMasteryAssessedAt: latest?.assessedAt ?? undefined, scheduleVersion: REVIEW_SCHEDULE_VERSION } });
    return { idempotent: false, eventId: input.eventId };
  });
}

export async function syncTeachBackReviewState(tx: typeof prisma, identity: Identity, input: { memoryItemId: string; masteryState: TeachBackMasteryState; assessedAt: Date }) {
  return tx.userCognitionReviewState.upsert({ where: { workspaceId_userId_memoryItemId: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: input.memoryItemId } }, create: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId: input.memoryItemId, reviewCount: 0, lastReviewedAt: input.assessedAt, nextReviewAt: nextReviewAt(input.assessedAt, input.masteryState, 0), lastMasteryState: input.masteryState, lastMasteryAssessedAt: input.assessedAt, scheduleVersion: REVIEW_SCHEDULE_VERSION }, update: { reviewCount: 0, lastReviewedAt: input.assessedAt, nextReviewAt: nextReviewAt(input.assessedAt, input.masteryState, 0), lastMasteryState: input.masteryState, lastMasteryAssessedAt: input.assessedAt, scheduleVersion: REVIEW_SCHEDULE_VERSION } });
}

/** Reconciles only the scheduling cache; TeachBackAssessment remains the mastery authority. */
export async function reconcilePersonalCognitionReviewState(identity: Identity, memoryItemId: string) {
  return prisma.$transaction(async tx => {
    const latest = await tx.teachBackAttempt.findFirst({ where: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId, status: "ASSESSED" }, include: { assessment: true }, orderBy: [{ assessedAt: "desc" }, { id: "desc" }] });
    if (!latest?.assessment || !latest.assessedAt) return null;
    const existing = await tx.userCognitionReviewState.findUnique({ where: { workspaceId_userId_memoryItemId: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId } } });
    const reviewCount = existing?.reviewCount ?? 0, lastReviewedAt = existing?.lastReviewedAt ?? latest.assessedAt;
    return tx.userCognitionReviewState.upsert({ where: { workspaceId_userId_memoryItemId: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId } }, create: { workspaceId: identity.workspaceId, userId: identity.userId, memoryItemId, reviewCount, lastReviewedAt, nextReviewAt: nextReviewAt(lastReviewedAt, latest.assessment.masteryState, reviewCount), lastMasteryState: latest.assessment.masteryState, lastMasteryAssessedAt: latest.assessedAt, scheduleVersion: REVIEW_SCHEDULE_VERSION }, update: { lastMasteryState: latest.assessment.masteryState, lastMasteryAssessedAt: latest.assessedAt, nextReviewAt: nextReviewAt(lastReviewedAt, latest.assessment.masteryState, reviewCount), scheduleVersion: REVIEW_SCHEDULE_VERSION } });
  });
}
