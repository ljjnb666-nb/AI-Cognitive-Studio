import { Prisma, prisma } from "@ai-cognitive/db";
import { canonicalEmbeddingInputHash, canonicalGatewayRequestFingerprint, stableHash, type GatewayRequest, type ProviderExecutionRepository } from "@ai-cognitive/provider-gateway";
import { sha256, validateEvidence } from "./chunking.js";
import { embeddingIdentityWithHash } from "./embeddings.js";

type Actor = { workspaceId: string; userId: string };
type Coordinate = { sourceBlockId: string; startOffset: number; endOffset: number };
export type BookRevisionPatch = {
  reason: string;
  archiveSha256: string;
  summary: { text: string; evidence: Coordinate[] };
  memories: Array<{ id: string; text?: string; addEvidence: Coordinate[] }>;
};
export type BookRevisionDecision = {
  verdict: "PASS" | "BLOCKED";
  notes: string;
  evidenceSha256: string;
};

async function authorize(tx: Prisma.TransactionClient, actor: Actor) {
  const member = await tx.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: actor.userId } },
  });
  if (!member || member.role === "VIEWER") throw new Error("BOOK_REVISION_FORBIDDEN");
}

const validText = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit;
const validHash = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

async function inspectPatch(tx: Prisma.TransactionClient, actor: Pick<Actor, "workspaceId">, runId: string, patch: BookRevisionPatch, requireCurrent = true) {
  const run = await tx.bookAnalysisRun.findFirst({
    where: { id: runId, workspaceId: actor.workspaceId, status: "SUCCEEDED", analysisStage: "COMPLETED" },
  });
  if (!run) throw new Error("BOOK_REVISION_BASE_NOT_AVAILABLE");
  const marker = await tx.currentBookIntelligence.findFirst({
    where: { workspaceId: run.workspaceId, sourceDocumentId: run.sourceDocumentId },
  });
  const extraction = await tx.currentDocumentExtraction.findFirst({ where: { workspaceId: run.workspaceId, sourceDocumentId: run.sourceDocumentId } });
  if (requireCurrent && (marker?.analysisRunId !== run.id || extraction?.extractionId !== run.extractionId)) throw new Error("BOOK_REVISION_BASE_NOT_CURRENT");

  if (!validText(patch?.reason, 2000) || !validHash(patch.archiveSha256) ||
      !validText(patch.summary?.text, 20000) || !Array.isArray(patch.summary.evidence) ||
      patch.summary.evidence.length < 1 || patch.summary.evidence.length > 128 ||
      !Array.isArray(patch.memories) || patch.memories.length > 64) {
    throw new Error("BOOK_REVISION_PATCH_INVALID");
  }

  const root = await tx.analysisArtifact.findFirst({
    where: { analysisRunId: run.id, workspaceId: run.workspaceId, scope: "BOOK", parentId: null },
  });
  if (!root) throw new Error("BOOK_REVISION_ROOT_NOT_FOUND");
  if (patch.memories.some(change => !change || !validText(change.id, 128))) throw new Error("BOOK_REVISION_PATCH_INVALID");
  const changes = [...patch.memories].sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(changes.map(change => change.id)).size !== changes.length) throw new Error("BOOK_REVISION_DUPLICATE_TARGET");

  const originals = await tx.bookMemoryItem.findMany({
    where: { id: { in: changes.map(change => change.id) }, analysisRunId: run.id, workspaceId: run.workspaceId, sourceArtifactId: root.id },
    include: { evidence: { orderBy: { id: "asc" } } },
    orderBy: { id: "asc" },
  });
  if (originals.length !== changes.length) throw new Error("BOOK_REVISION_TARGET_NOT_FOUND");
  const byId = new Map(originals.map(item => [item.id, item]));
  const vectorRefreshMemoryIds: string[] = [];
  for (const change of changes) {
    if (!Array.isArray(change.addEvidence) || change.addEvidence.length < 1 || change.addEvidence.length > 32 ||
        (change.text !== undefined && !validText(change.text, 20000))) throw new Error("BOOK_REVISION_PATCH_INVALID");
    if (change.text !== undefined && change.text !== byId.get(change.id)!.content) vectorRefreshMemoryIds.push(change.id);
  }

  const coordinates = [...patch.summary.evidence, ...changes.flatMap(change => change.addEvidence)];
  if (coordinates.some(span => !span || typeof span.sourceBlockId !== "string")) throw new Error("BOOK_REVISION_EVIDENCE_INVALID");
  const sourceIds = [...new Set(coordinates.map(span => span.sourceBlockId))];
  const [blocks, sourceSpans] = await Promise.all([
    tx.sourceBlock.findMany({ where: { id: { in: sourceIds }, extractionId: run.extractionId } }),
    tx.chunkSourceSpan.findMany({
      where: { sourceBlockId: { in: sourceIds }, extractionId: run.extractionId, chunk: { chunkSetId: run.chunkSetId } },
      orderBy: { startOffset: "asc" },
    }),
  ]);
  const bySource = new Map(blocks.map(block => [block.id, block]));
  for (const span of coordinates) {
    const block = bySource.get(span.sourceBlockId);
    if (!block || !validateEvidence(block, span)) throw new Error("BOOK_REVISION_EVIDENCE_INVALID");
    let covered = span.startOffset;
    for (const source of sourceSpans) {
      if (source.sourceBlockId === span.sourceBlockId && source.startOffset <= covered) covered = Math.max(covered, source.endOffset);
    }
    if (covered < span.endOffset) throw new Error("BOOK_REVISION_EVIDENCE_OUTSIDE_CHUNKS");
  }

  const originalHash = stableHash(JSON.parse(JSON.stringify({ root, originals, sources: blocks.map(block => ({ id: block.id, textHash: stableHash(block.text) })).sort((a, b) => a.id.localeCompare(b.id)) })));
  const normalized = JSON.parse(JSON.stringify({ ...patch, memories: changes })) as Prisma.InputJsonValue;
  return { run, root, originals, originalHash, normalized, vectorRefreshMemoryIds, revisionHash: stableHash({ originalHash, patch: normalized }) };
}

export async function createBookRevision(actor: Actor, runId: string, patch: BookRevisionPatch) {
  return prisma.$transaction(async tx => {
    await authorize(tx, actor);
    const { run, originalHash, normalized, revisionHash, vectorRefreshMemoryIds } = await inspectPatch(tx, actor, runId, patch);
    const revision = await tx.bookIntelligenceRevision.upsert({
      where: { analysisRunId_revisionHash: { analysisRunId: run.id, revisionHash } },
      update: {},
      create: {
        analysisRunId: run.id, workspaceId: run.workspaceId, sourceDocumentId: run.sourceDocumentId,
        extractionId: run.extractionId, chunkSetId: run.chunkSetId, createdByUserId: actor.userId,
        originalHash, revisionHash, patch: normalized,
      },
    });
    return { revision, vectorRefreshMemoryIds };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/** Records a human decision separately from automatic scope and span validation. */
export async function reviewBookRevision(actor: Actor, revisionId: string, expectedHash: string, decision: BookRevisionDecision) {
  return prisma.$transaction(async tx => {
    await authorize(tx, actor);
    const revision = await tx.bookIntelligenceRevision.findFirst({ where: { id: revisionId, workspaceId: actor.workspaceId } });
    if (!revision || revision.revisionHash !== expectedHash) throw new Error("BOOK_REVISION_CONFLICT");
    if (!["PASS", "BLOCKED"].includes(decision?.verdict) || !validText(decision.notes, 12000) || !validHash(decision.evidenceSha256)) {
      throw new Error("BOOK_REVISION_REVIEW_INVALID");
    }
    const inspected = await inspectPatch(tx, actor, revision.analysisRunId, revision.patch as unknown as BookRevisionPatch);
    if (inspected.originalHash !== revision.originalHash || inspected.revisionHash !== expectedHash) throw new Error("BOOK_REVISION_CONTENT_CHANGED");
    const reviewHash = stableHash({ expectedHash, decision, reviewerUserId: actor.userId });
    const vectorReady = inspected.vectorRefreshMemoryIds.length === 0;
    const review = await tx.bookIntelligenceRevisionReview.upsert({
      where: { revisionId_reviewHash: { revisionId, reviewHash } },
      update: {},
      create: { revisionId, reviewerUserId: actor.userId, revisionHash: expectedHash, reviewHash, decision, vectorReady },
    });
    return { review, vectorRefreshMemoryIds: inspected.vectorRefreshMemoryIds };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function readRevisionSnapshot(tx: Prisma.TransactionClient, actor: Pick<Actor, "workspaceId">, revisionId: string, expectedHash: string, requireCurrent = true, publishedReviewHash?: string) {
  const revision = await tx.bookIntelligenceRevision.findFirst({ where: { id: revisionId, workspaceId: actor.workspaceId } });
  if (!revision || revision.revisionHash !== expectedHash) throw new Error("BOOK_REVISION_CONFLICT");

  const patch = revision.patch as unknown as BookRevisionPatch;
  const inspected = await inspectPatch(tx, actor, revision.analysisRunId, patch, requireCurrent);
  if (inspected.originalHash !== revision.originalHash || inspected.revisionHash !== expectedHash) {
    throw new Error("BOOK_REVISION_CONTENT_CHANGED");
  }
  const job = await tx.job.findUniqueOrThrow({ where: { id: inspected.run.jobId }, select: { result: true } });
  const identity = (job.result as { embeddingIdentityHash?: unknown } | null)?.embeddingIdentityHash;
  const embeddings = typeof identity === "string" ? await tx.bookMemoryEmbedding.findMany({
    where: {
      workspaceId: revision.workspaceId,
      extractionId: revision.extractionId,
      analysisRunId: revision.analysisRunId,
      memoryItemId: { in: patch.memories.map(change => change.id) },
      embeddingIdentityHash: identity,
    },
    select: { memoryItemId: true, provider: true, model: true, modelVersion: true, embeddingVersion: true, dimensions: true, embeddingIdentityHash: true },
  }) : [];
  const byId = new Map(inspected.originals.map(memory => [memory.id, memory]));
  const byEmbedding = new Map(embeddings.map(embedding => [embedding.memoryItemId, embedding]));
  const replacements = await tx.bookRevisionMemoryEmbedding.findMany({ where: {
    revisionId, analysisRunId: inspected.run.id, workspaceId: inspected.run.workspaceId,
    extractionId: inspected.run.extractionId,
  } });
  const byReplacement = new Map(replacements.map(item => [item.memoryItemId, item]));
  const memories = patch.memories.map(change => {
    const original = byId.get(change.id)!;
    const text = change.text ?? original.content;
    const inputHash = sha256(text);
    const originalInputHash = sha256(original.content);
    if (originalInputHash !== original.contentHash) throw new Error("BOOK_REVISION_ORIGINAL_CONTENT_HASH_INVALID");
    const embedding = byEmbedding.get(change.id) ?? null;
    const replacement = byReplacement.get(change.id);
    const refreshedVector = inputHash !== originalInputHash && embedding &&
      replacement?.inputHash === inputHash && replacement.embeddingIdentityHash === embedding.embeddingIdentityHash &&
      replacement.dimensions === embedding.dimensions && Array.isArray(replacement.vector) &&
      replacement.vector.length === embedding.dimensions &&
      replacement.vector.every((value): value is number => typeof value === "number" && Number.isFinite(value)) &&
      replacement.vector.some(value => value !== 0) ? replacement.vector : null;
    return {
      id: original.id, before: original.content, after: text, addedEvidence: change.addEvidence,
      originalInputHash, inputHash, embedding, refreshedVector,
      vectorState: !embedding ? "ORIGINAL_VECTOR_MISSING" as const :
        inputHash === originalInputHash ? "REUSE" as const : refreshedVector ? "REFRESHED" as const : "REFRESH_REQUIRED" as const,
    };
  });
  const review = await tx.bookIntelligenceRevisionReview.findFirst({
    where: { revisionId, revisionHash: expectedHash, ...(publishedReviewHash ? { reviewHash: publishedReviewHash } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (review && stableHash({ expectedHash, decision: review.decision, reviewerUserId: review.reviewerUserId }) !== review.reviewHash) {
    throw new Error("BOOK_REVISION_REVIEW_CONTENT_CHANGED");
  }
  return {
    revisionId, revisionHash: expectedHash, analysisRunId: inspected.run.id,
    summary: { before: inspected.root.summary, after: patch.summary.text, evidence: patch.summary.evidence },
    memories, review, vectorReady: memories.every(memory => memory.vectorState === "REUSE" || memory.vectorState === "REFRESHED"),
  };

}

/** Read an editorial preview and its vector dependencies from one database snapshot. */
export async function previewBookRevision(actor: Actor, revisionId: string, expectedHash: string) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await authorize(tx, actor);
    return readRevisionSnapshot(tx, actor, revisionId, expectedHash);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** Prepare one exact input. Authorization to execute a paid request is separate. */
export async function prepareBookRevisionEmbedding(actor: Actor, revisionId: string, revisionHash: string, memoryItemId: string) {
  const preview = await previewBookRevision(actor, revisionId, revisionHash);
  const memory = preview.memories.find(item => item.id === memoryItemId);
  if (!memory?.embedding || memory.inputHash === memory.originalInputHash) throw new Error("BOOK_REVISION_VECTOR_TARGET_INVALID");
  const embedding = { texts: [memory.after], purpose: "DOCUMENT" as const };
  const request = {
    workspaceId: actor.workspaceId, routeSlot: "EMBEDDING",
    correlationId: revisionId, idempotencyKey: `book-revision:embedding-v1:${revisionId}:${memoryItemId}`,
    inputHash: canonicalEmbeddingInputHash(embedding), capability: { family: "EMBEDDING" },
    embedding, pipelineVersion: `book-revision-v1:${revisionHash}:${memoryItemId}`,
  } satisfies GatewayRequest;
  return { request, inputHash: memory.inputHash, embedding: memory.embedding };
}

/** Consume a previously authorized Gateway result without making a provider call. */
export async function materializeBookRevisionEmbedding(repository: ProviderExecutionRepository, actor: Actor, input: {
  revisionId: string; revisionHash: string; memoryItemId: string; invocationId: string; snapshotId: string;
}) {
  const prepared = await prepareBookRevisionEmbedding(actor, input.revisionId, input.revisionHash, input.memoryItemId);
  const { workspaceId } = actor;
  const snapshot = await repository.loadExecutionSnapshot(workspaceId, input.snapshotId);
  const fingerprint = canonicalGatewayRequestFingerprint(snapshot, prepared.request);
  const invocation = await prisma.providerInvocation.findFirst({ where: {
    id: input.invocationId, workspaceId, snapshotId: input.snapshotId, routeSlot: "EMBEDDING",
    idempotencyKey: prepared.request.idempotencyKey, requestFingerprint: fingerprint, status: "SUCCEEDED",
  } });
  if (!invocation) throw new Error("BOOK_REVISION_VECTOR_REQUEST_MISMATCH");
  return repository.consumeEmbeddingResult({
    workspaceId, invocationId: invocation.id, snapshotId: snapshot.id,
    consumerKind: "BOOK_REVISION_MEMORY", consumerKey: prepared.request.idempotencyKey,
    consumerFingerprint: fingerprint,
  }, async ({ tx, vectors, snapshot: pinned, receipt }) => {
    await authorize(tx, actor);
    const preview = await readRevisionSnapshot(tx, actor, input.revisionId, input.revisionHash);
    const target = preview.memories.find(memory => memory.id === input.memoryItemId);
    const baseline = target?.embedding;
    if (!baseline || target.vectorState !== "REFRESH_REQUIRED" || target.inputHash !== prepared.inputHash ||
        pinned.routeSlot !== "EMBEDDING" || receipt.vectorCount !== 1 || vectors.length !== 1) {
      throw new Error("BOOK_REVISION_VECTOR_TARGET_INVALID");
    }
    const identity = embeddingIdentityWithHash({
      provider: pinned.providerKey, model: pinned.modelId,
      embeddingVersion: baseline.embeddingVersion, dimensions: receipt.dimensions,
    });
    const vector = vectors[0]!;
    if (identity.hash !== baseline.embeddingIdentityHash || vector.length !== identity.dimensions ||
        !vector.every(Number.isFinite) || !vector.some(value => value !== 0)) {
      throw new Error("BOOK_REVISION_VECTOR_IDENTITY_MISMATCH");
    }
    const run = await tx.bookAnalysisRun.findUniqueOrThrow({ where: { id: preview.analysisRunId } });
    await tx.bookRevisionMemoryEmbedding.create({ data: {
      revisionId: input.revisionId, memoryItemId: input.memoryItemId, workspaceId,
      analysisRunId: run.id, extractionId: run.extractionId, invocationId: invocation.id,
      inputHash: target.inputHash, embeddingIdentityHash: identity.hash, dimensions: identity.dimensions, vector,
    } });
  });
}

/** Read the journal-selected overlay. Null revision means the original is active. */
export async function readPublishedBookRevision(actor: Actor, sourceDocumentId: string) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const member = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: actor.workspaceId, userId: actor.userId } },
    });
    if (!member) throw new Error("BOOK_REVISION_FORBIDDEN");
    const marker = await tx.currentBookIntelligence.findFirst({
      where: { workspaceId: actor.workspaceId, sourceDocumentId },
    });
    const extraction = await tx.currentDocumentExtraction.findFirst({
      where: { workspaceId: actor.workspaceId, sourceDocumentId },
    });
    if (!marker || marker.extractionId !== extraction?.extractionId) throw new Error("BOOK_REVISION_BASE_NOT_CURRENT");
    return readPublishedBookRevisionForRun(tx, marker);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** Internal reader. The caller must scope and authorize the Run in the same snapshot. */
export async function readPublishedBookRevisionForRun(
  tx: Prisma.TransactionClient,
  scope: { workspaceId: string; analysisRunId: string },
  pinnedPublicationId?: string,
) {
  const event = await tx.bookRevisionPublication.findFirst({
    where: { analysisRunId: scope.analysisRunId, ...(pinnedPublicationId ? { id: pinnedPublicationId } : {}) }, orderBy: { sequence: "desc" },
    include: { revision: { select: { revisionHash: true } } },
  });
  if (pinnedPublicationId && !event?.revisionId) throw new Error("BOOK_REVISION_PIN_INVALID");
  if (!event?.revisionId) return { analysisRunId: scope.analysisRunId, publicationId: event?.id ?? null, revision: null };
  if (!event.revision || !event.reviewHash) throw new Error("BOOK_REVISION_PUBLICATION_BROKEN");
  const revision = await readRevisionSnapshot(tx, scope, event.revisionId, event.revision.revisionHash, !pinnedPublicationId, event.reviewHash);
  if (!revision.vectorReady || revision.review?.reviewHash !== event.reviewHash ||
      (revision.review?.decision as BookRevisionDecision | undefined)?.verdict !== "PASS") {
    throw new Error("BOOK_REVISION_PUBLICATION_NOT_CONSUMABLE");
  }
  return { analysisRunId: scope.analysisRunId, publicationId: event.id, revision };

}

type PublicationCommand = {
  analysisRunId: string;
  expectedPublicationId: string | null;
  requestId: string;
  action: "PUBLISH" | "ROLLBACK";
  revisionId: string | null;
  revisionHash: string | null;
};

/**
 * Wire this service only to a consumer integration that understands the revision
 * journal. Readiness is injected by trusted server composition, never by a request.
 */
export function createBookRevisionPublicationService(dependencies: {
  assertConsumersReady: (tx: Prisma.TransactionClient, lineage: {
    workspaceId: string; sourceDocumentId: string; analysisRunId: string;
  }) => Promise<void>;
}) {
  return async (actor: Actor, command: PublicationCommand) => {
    if (!validText(command.requestId, 128) ||
        !["PUBLISH", "ROLLBACK"].includes(command.action) ||
        (command.revisionId === null ? command.revisionHash !== null || command.action === "PUBLISH" : !validHash(command.revisionHash))) {
      throw new Error("BOOK_REVISION_PUBLICATION_INVALID");
    }
    const requestHash = stableHash({ actor, command });
    try {
      return await prisma.$transaction(async tx => {
        await authorize(tx, actor);
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "BookAnalysisRun"
          WHERE id = ${command.analysisRunId} AND "workspaceId" = ${actor.workspaceId}
          FOR UPDATE
        `;
        if (locked.length !== 1) throw new Error("BOOK_REVISION_BASE_NOT_AVAILABLE");
        const run = await tx.bookAnalysisRun.findUniqueOrThrow({ where: { id: command.analysisRunId } });
        const marker = await tx.currentBookIntelligence.findFirst({
          where: { workspaceId: run.workspaceId, sourceDocumentId: run.sourceDocumentId },
        });
        const extraction = await tx.currentDocumentExtraction.findFirst({
          where: { workspaceId: run.workspaceId, sourceDocumentId: run.sourceDocumentId },
        });
        if (run.status !== "SUCCEEDED" || run.analysisStage !== "COMPLETED" ||
            marker?.analysisRunId !== run.id || extraction?.extractionId !== run.extractionId) {
          throw new Error("BOOK_REVISION_BASE_NOT_CURRENT");
        }

        const priorRequest = await tx.bookRevisionPublication.findUnique({
          where: { analysisRunId_requestId: { analysisRunId: run.id, requestId: command.requestId } },
        });
        if (priorRequest) {
          if (priorRequest.requestHash !== requestHash) throw new Error("BOOK_REVISION_REQUEST_CONFLICT");
          return priorRequest;
        }
        const current = await tx.bookRevisionPublication.findFirst({
          where: { analysisRunId: run.id }, orderBy: { sequence: "desc" },
        });
        if ((current?.id ?? null) !== command.expectedPublicationId) throw new Error("BOOK_REVISION_PUBLICATION_CONFLICT");
        if (command.action === "ROLLBACK") {
          if (!current || current.revisionId === command.revisionId) throw new Error("BOOK_REVISION_ROLLBACK_TARGET_INVALID");
          if (command.revisionId !== null && !await tx.bookRevisionPublication.findFirst({
            where: { analysisRunId: run.id, revisionId: command.revisionId },
          })) throw new Error("BOOK_REVISION_ROLLBACK_TARGET_INVALID");
        }

        let reviewHash: string | null = null;
        if (command.revisionId !== null) {
          const revision = await tx.bookIntelligenceRevision.findFirst({
            where: { id: command.revisionId, analysisRunId: run.id, workspaceId: actor.workspaceId },
          });
          if (!revision || revision.revisionHash !== command.revisionHash) throw new Error("BOOK_REVISION_CONFLICT");
          const review = await tx.bookIntelligenceRevisionReview.findFirst({
            where: { revisionId: revision.id, revisionHash: revision.revisionHash },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          });
          if (!review || (review.decision as BookRevisionDecision).verdict !== "PASS" ||
              stableHash({ expectedHash: revision.revisionHash, decision: review.decision, reviewerUserId: review.reviewerUserId }) !== review.reviewHash) {
            throw new Error("BOOK_REVISION_REVIEW_REQUIRED");
          }
          const readiness = await readRevisionSnapshot(tx, actor, revision.id, revision.revisionHash, true, review.reviewHash);
          if (!readiness.vectorReady) {
            throw new Error("BOOK_REVISION_VECTOR_NOT_READY");
          }
          reviewHash = review.reviewHash;
        }

        await dependencies.assertConsumersReady(tx, {
          workspaceId: run.workspaceId, sourceDocumentId: run.sourceDocumentId, analysisRunId: run.id,
        });
        return tx.bookRevisionPublication.create({ data: {
          analysisRunId: run.id, revisionId: command.revisionId, action: command.action,
          requestId: command.requestId, requestHash, actorUserId: actor.userId, reviewHash,
          sequence: (current?.sequence ?? 0) + 1, previousId: current?.id ?? null,
        } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code)) {
        throw new Error("BOOK_REVISION_PUBLICATION_CONFLICT", { cause: error });
      }
      throw error;
    }
  };
}

/** Capture all source versions in one snapshot before allocating an asynchronous job. */
export async function pinCurrentBookSources(workspaceId: string, sourceIds: string[]) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const current = await tx.currentBookIntelligence.findMany({
      where: { workspaceId, sourceDocumentId: { in: sourceIds } },
    });
    if (current.length !== sourceIds.length) throw new Error("CURRENT_BOOK_INTELLIGENCE_REQUIRED");
    const extractions = await tx.currentDocumentExtraction.findMany({
      where: { workspaceId, sourceDocumentId: { in: sourceIds } },
    });
    const extractionByDocument = new Map(extractions.map(row => [row.sourceDocumentId, row.extractionId]));
    return Promise.all(current.map(async marker => {
      if (extractionByDocument.get(marker.sourceDocumentId) !== marker.extractionId) throw new Error("BOOK_INTELLIGENCE_STALE");
      const published = await readPublishedBookRevisionForRun(tx, marker);
      return { ...marker, bookPublicationId: published.revision ? published.publicationId : null };
    }));
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
