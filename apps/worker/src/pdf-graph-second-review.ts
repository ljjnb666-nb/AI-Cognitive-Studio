import { createHash, randomUUID } from "node:crypto";
import { prisma, Prisma } from "@ai-cognitive/db";
import { pdfReviewCandidateFingerprint } from "@ai-cognitive/domain";
import { DEFAULT_PARSER_LIMITS, renderPdfMixedPageSourcePreviews, validatePdfVisualStructureCandidate } from "@ai-cognitive/ingestion";
import { createGatewayPdfGraphModelReviewer, validatePdfGraphModelReview, type PdfGraphModelVerdict, type ProviderGateway, type ProviderExecutionRepository } from "@ai-cognitive/provider-gateway";
import { S3CompatibleStorageProvider, type StorageProvider } from "@ai-cognitive/storage";
import type { Environment } from "@ai-cognitive/shared/server";
import { createManagedPdfVisualReviewRuntime } from "./pdf-visual-review.js";
import { createBookProductionGatewayRuntime } from "./provider-gateway-runtime.js";

const HASH = /^[0-9a-f]{64}$/;
const MAX_PDF_BYTES = 110_000_000;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type ReviewTask = {
  requestId: string; workspaceId: string; userId: string;
  sourceDocumentId: string; ingestionRunId: string; routingGeneration: number;
  physicalPageIndex: number; sourcePdfSha256: string;
  sourcePngSha256: string; candidateSha256: string;
  candidateJson: unknown;
  sourceTextExcerpt: string; sourceTextPreviewTruncated: boolean;
  sourcePdfKey: string; sourcePdfBytes: bigint;
};
export type SecondReviewDecision = {
  decision: PdfGraphModelVerdict;
  invocationId: string; snapshotId: string;
  approvedForPodcast: false; approvedForBookIntelligence: false;
};
type Execute = (task: ReviewTask) => Promise<SecondReviewDecision>;

function fail(): never { throw Error("PDF_SECOND_REVIEW_SOURCE_OR_AUTHORITY_INVALID"); }

/** Current extraction and consented source identity are checked independently
 * both before remote execution and before recording the verdict. */
async function currentSourceBound(task: ReviewTask): Promise<boolean> {
  const current = await prisma.currentDocumentExtraction.findFirst({
    where: {
      workspaceId: task.workspaceId, sourceDocumentId: task.sourceDocumentId,
      extraction: {
        ingestionRunId: task.ingestionRunId, status: "SUCCEEDED",
      },
    },
    select: { id: true },
  });
  const run = await prisma.ingestionRun.findFirst({
    where: { id: task.ingestionRunId, workspaceId: task.workspaceId,
      sourceDocumentId: task.sourceDocumentId, status: "SUCCEEDED",
      routingGeneration: task.routingGeneration,
      sourceDocument: {
        sha256: task.sourcePdfSha256, mediaType: "application/pdf",
        storageKey: task.sourcePdfKey, sizeBytes: task.sourcePdfBytes,
      },
    },
    select: { id: true },
  });
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: {
      workspaceId: task.workspaceId, userId: task.userId,
    } },
    select: { role: true },
  });
  const route = await prisma.providerRouteBinding.findFirst({
    where: { workspaceId: task.workspaceId, routeSlot: "PDF_VISUAL_STRUCTURE",
      connection: { status: "ACTIVE" } },
    select: { id: true },
  });
  return Boolean(current && run && member && member.role !== "VIEWER" && route);
}

/** One explicit operator-driven paid admission. NEVER registered as a
 * background sweep. Claimed RUNNING rows have no retry/rearm path, because
 * a lost provider reply might still represent a billed invocation. */
export async function processNextPdfGraphSecondReviewRequest(
  options: { enabled: true; execute: Execute; repository: Pick<ProviderExecutionRepository,"consumeTextResult"> },
): Promise<"IDLE" | "DONE"> {
  if (options.enabled !== true || typeof options.execute !== "function" ||
      typeof options.repository?.consumeTextResult !== "function") fail();
  const now = new Date();
  await prisma.pdfGraphSecondReviewRequest.updateMany({
    where: { status: "AUTHORIZED_NOT_DISPATCHED", expiresAt: { lte: now } },
    data: { status: "EXPIRED", completedAt: now, failureCode: "PDF_SECOND_REVIEW_CONSENT_EXPIRED" },
  });
  const candidate = await prisma.pdfGraphSecondReviewRequest.findFirst({
    where: { status: "AUTHORIZED_NOT_DISPATCHED", expiresAt: { gt: now } },
    orderBy: { consentRecordedAt: "asc" },
  });
  if (!candidate) return "IDLE";
  const token = randomUUID();
  const claimed = await prisma.pdfGraphSecondReviewRequest.updateMany({
    where: { id: candidate.id, status: "AUTHORIZED_NOT_DISPATCHED",
      claimToken: null, expiresAt: { gt: new Date() } },
    data: { status: "RUNNING", claimToken: token, startedAt: new Date() },
  });
  if (claimed.count !== 1) return "IDLE";

  let invocationId: string | null = null, snapshotId: string | null = null;
  try {
    const run = await prisma.ingestionRun.findFirst({
      where: { id: candidate.ingestionRunId, workspaceId: candidate.workspaceId,
        sourceDocumentId: candidate.sourceDocumentId, status: "SUCCEEDED",
        routingGeneration: candidate.routingGeneration,
        sourceDocument: { sha256: candidate.sourcePdfSha256, mediaType: "application/pdf" } },
      select: { sourceDocument: { select: { storageKey: true, sizeBytes: true } } },
    });
    if (!run || !run.sourceDocument.storageKey ||
        run.sourceDocument.sizeBytes < 5n ||
        run.sourceDocument.sizeBytes > BigInt(MAX_PDF_BYTES) ||
        !HASH.test(candidate.sourcePdfSha256) ||
        !HASH.test(candidate.sourcePngSha256) || !HASH.test(candidate.candidateSha256)) fail();
    const taskBase: ReviewTask = {
      requestId: candidate.id, workspaceId: candidate.workspaceId, userId: candidate.userId,
      sourceDocumentId: candidate.sourceDocumentId,
      ingestionRunId: candidate.ingestionRunId, routingGeneration: candidate.routingGeneration,
      physicalPageIndex: candidate.physicalPageIndex, sourcePdfSha256: candidate.sourcePdfSha256,
      sourcePngSha256: candidate.sourcePngSha256, candidateSha256: candidate.candidateSha256,
      sourcePdfKey: run.sourceDocument.storageKey, sourcePdfBytes: run.sourceDocument.sizeBytes,
      candidateJson: null, sourceTextExcerpt: "", sourceTextPreviewTruncated: true,
    };
    if (!await currentSourceBound(taskBase)) fail();
    const [graph, extraction] = await Promise.all([
      prisma.pdfVisualReviewCandidate.findFirst({
        where: {
          ingestionRunId: taskBase.ingestionRunId,
          workspaceId: taskBase.workspaceId, sourceDocumentId: taskBase.sourceDocumentId,
          routingGeneration: taskBase.routingGeneration,
          physicalPageIndex: taskBase.physicalPageIndex,
          sourcePdfSha256: taskBase.sourcePdfSha256,
          sourcePngSha256: taskBase.sourcePngSha256,
          candidateSha256: taskBase.candidateSha256,
          expiresAt: { gt: new Date() },
        },
        select: { candidateJson: true },
      }),
      prisma.documentExtraction.findFirst({
        where: { ingestionRunId: taskBase.ingestionRunId,
          workspaceId: taskBase.workspaceId, sourceDocumentId: taskBase.sourceDocumentId,
          status: "SUCCEEDED" },
        select: { id: true },
      }),
    ]);
    if (!graph || !extraction || !Array.isArray((graph.candidateJson as { figures?: unknown })?.figures) ||
        !validatePdfVisualStructureCandidate(graph.candidateJson).length ||
        pdfReviewCandidateFingerprint(graph.candidateJson) !== taskBase.candidateSha256) fail();
    const page = await prisma.sourcePage.findFirst({
      where: { extractionId: extraction.id, physicalPageIndex: taskBase.physicalPageIndex },
      select: { id: true },
    });
    if (!page) fail();
    const [total, blocks] = await Promise.all([
      prisma.sourceBlock.count({ where: { extractionId: extraction.id, sourcePageId: page.id } }),
      prisma.sourceBlock.findMany({
        where: { extractionId: extraction.id, sourcePageId: page.id },
        select: { text: true }, orderBy: { ordinal: "asc" }, take: 17,
      }),
    ]);
    const allText = blocks.slice(0, 16).map(b => b.text).join("\n");
    const text = allText.slice(0, 1500);
    if (!text.trim()) fail();
    const task: ReviewTask = {
      ...taskBase, candidateJson: graph.candidateJson, sourceTextExcerpt: text,
      sourceTextPreviewTruncated: total > 16 || blocks.length > 16 || allText.length > text.length,
    };
    if (!await currentSourceBound(task)) fail();
    const output = await options.execute(task);
    if (!output || !output.invocationId || !output.snapshotId ||
        output.approvedForPodcast !== false || output.approvedForBookIntelligence !== false ||
        output.decision.approvedForPodcast !== false ||
        output.decision.approvedForBookIntelligence !== false ||
        !["PASSED", "REJECTED", "REVIEW_REQUIRED"].includes(output.decision.status)) fail();
    invocationId = output.invocationId;
    snapshotId = output.snapshotId;
    const expected = {
      sourceSha256: task.sourcePdfSha256,
      sourcePngSha256: task.sourcePngSha256,
      physicalPageIndex: task.physicalPageIndex,
      candidateSha256: task.candidateSha256,
      textSha256: sha256(Buffer.from(task.sourceTextExcerpt.slice(0,1_500), "utf8")),
    };
    const fingerprint = createHash("sha256").update(JSON.stringify([
      task.requestId, task.ingestionRunId, task.routingGeneration,
      task.physicalPageIndex, task.sourcePdfSha256, task.sourcePngSha256,
      task.candidateSha256, expected.textSha256,
    ])).digest("hex");
    const consumed = await options.repository.consumeTextResult({
      workspaceId: task.workspaceId, invocationId: output.invocationId,
      snapshotId: output.snapshotId, consumerKind: "PDF_GRAPH_SECOND_REVIEW",
      consumerKey: task.requestId, consumerFingerprint: fingerprint,
    }, async ({ tx, response, snapshot }) => {
      // Lock the sole paid admission while materializing and purging the
      // encrypted text receipt. Both changes are in ONE repository transaction.
      await tx.$queryRaw`SELECT "id" FROM "PdfGraphSecondReviewRequest"
        WHERE "id" = ${task.requestId} FOR UPDATE`;
      const held = await tx.pdfGraphSecondReviewRequest.findFirst({
        where: { id: task.requestId, claimToken: token, status: "RUNNING",
          workspaceId: task.workspaceId, ingestionRunId: task.ingestionRunId,
          routingGeneration: task.routingGeneration,
          physicalPageIndex: task.physicalPageIndex,
          sourcePdfSha256: task.sourcePdfSha256,
          sourcePngSha256: task.sourcePngSha256,
          candidateSha256: task.candidateSha256 },
        select: { id: true, expiresAt: true },
      });
      if (!held) fail();
      if (snapshot.id !== output.snapshotId ||
          snapshot.workspaceId !== task.workspaceId ||
          snapshot.routeSlot !== "PDF_VISUAL_STRUCTURE" ||
          response.type !== "STRUCTURED" || response.finishReason !== "STOP") fail();
      // HOLD SHARE locks so a concurrent membership revocation / extraction
      // switch cannot commit between our final check and receipt purging.
      const memberLock = await tx.$queryRaw<Array<{ userId: string }>>`SELECT "userId"
        FROM "WorkspaceMember" WHERE "workspaceId" = ${task.workspaceId}
        AND "userId" = ${task.userId} FOR SHARE`;
      const extractionLock = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id"
        FROM "CurrentDocumentExtraction" WHERE "workspaceId" = ${task.workspaceId}
        AND "sourceDocumentId" = ${task.sourceDocumentId} FOR SHARE`;
      if (memberLock.length !== 1 || extractionLock.length !== 1) fail();
      // Source and paid-call authorization must STILL be live at commit time.
      // Model output never overrides a revoked member or a replaced extraction.
      const [current, run, member, route, graph] = await Promise.all([
        tx.currentDocumentExtraction.findFirst({
          where: { sourceDocumentId: task.sourceDocumentId,
            workspaceId: task.workspaceId, extraction: {
              ingestionRunId: task.ingestionRunId, status: "SUCCEEDED" } },
          select: { id: true },
        }),
        tx.ingestionRun.findFirst({
          where: { id: task.ingestionRunId, workspaceId: task.workspaceId,
            sourceDocumentId: task.sourceDocumentId,
            routingGeneration: task.routingGeneration, status: "SUCCEEDED",
            sourceDocument: { sha256: task.sourcePdfSha256,
              mediaType: "application/pdf", storageKey: task.sourcePdfKey,
              sizeBytes: task.sourcePdfBytes } },
          select: { id: true },
        }),
        tx.workspaceMember.findUnique({
          where: { workspaceId_userId: {
            workspaceId: task.workspaceId, userId: task.userId } },
          select: { role: true },
        }),
        tx.providerRouteBinding.findFirst({
          where: { workspaceId: task.workspaceId, routeSlot: "PDF_VISUAL_STRUCTURE",
            connection: { status: "ACTIVE" } },
          select: { connectionId: true, modelId: true },
        }),
        tx.pdfVisualReviewCandidate.findFirst({
          where: { workspaceId: task.workspaceId, sourceDocumentId: task.sourceDocumentId,
            ingestionRunId: task.ingestionRunId,
            routingGeneration: task.routingGeneration,
            physicalPageIndex: task.physicalPageIndex,
            sourcePdfSha256: task.sourcePdfSha256,
            sourcePngSha256: task.sourcePngSha256,
            candidateSha256: task.candidateSha256,
            expiresAt: { gt: new Date() } },
          select: { id: true },
        }),
      ]);
      if (!current || !run || !member || member.role === "VIEWER" ||
          !route || !graph || route.modelId !== snapshot.modelId ||
          route.connectionId !== snapshot.connectionId ||
          held.expiresAt <= new Date()) fail();
      const verified = validatePdfGraphModelReview(
        response.structured, expected, task.sourceTextPreviewTruncated,
      );
      if (verified.status !== output.decision.status ||
          JSON.stringify(verified.axes) !== JSON.stringify(output.decision.axes) ||
          verified.approvedForPodcast !== false ||
          verified.approvedForBookIntelligence !== false) fail();
      const applied = await tx.pdfGraphSecondReviewRequest.updateMany({
        where: { id: task.requestId, claimToken: token, status: "RUNNING" },
        data: { status: verified.status === "PASSED" ? "SUCCEEDED" : verified.status,
          modelDecision: verified.status,
          modelAxes: JSON.parse(JSON.stringify(verified.axes)) as Prisma.InputJsonValue,
          invocationId: output.invocationId, snapshotId: output.snapshotId,
          completedAt: new Date(), claimToken: null, failureCode: null },
      });
      if (applied.count !== 1) fail();
    });
    if (consumed.status !== "CONSUMED") fail();
    return "DONE";
  } catch {
    // A network error, uncertain remote outcome or stale source is never
    // permission for a second call. No raw book/provider details are logged.
  }
  const final = await prisma.pdfGraphSecondReviewRequest.updateMany({
    where: { id: candidate.id, status: "RUNNING", claimToken: token },
    data: {
      status: "FAILED", failureCode: "PDF_SECOND_REVIEW_FAILED_OR_UNCERTAIN",
      completedAt: new Date(), invocationId, snapshotId, claimToken: null,
    },
  });
  if (final.count !== 1) throw Error("PDF_SECOND_REVIEW_CLAIM_LOST");
  return "DONE";
}

/** Explicitly invoked single page source rehydration. Does not persist PNG.
 * A different renderer, page, byte stream or graph digest is a hard stop. */
export function createPdfGraphSecondReviewExecutor(deps: {
  storage: Pick<StorageProvider, "headObject" | "getObjectStream">;
  gateway: ProviderGateway;
}): Execute {
  return async task => {
    const metadata = await deps.storage.headObject(task.sourcePdfKey);
    if (!metadata || metadata.size !== Number(task.sourcePdfBytes)) fail();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of await deps.storage.getObjectStream(task.sourcePdfKey)) {
      size += chunk.byteLength;
      if (size > MAX_PDF_BYTES || size > metadata.size) fail();
      chunks.push(chunk);
    }
    if (size !== metadata.size) fail();
    const bytes = new Uint8Array(size);
    let pos = 0;
    for (const part of chunks) { bytes.set(part, pos); pos += part.byteLength; }
    if (sha256(bytes) !== task.sourcePdfSha256 ||
        Buffer.from(bytes.subarray(0,5)).toString("ascii") !== "%PDF-") fail();
    // Only original mixed text+visual pages supported by the existing,
    // deterministic, isolated PDF.js renderer. Never substitute a new image.
    const renders = await renderPdfMixedPageSourcePreviews(
      bytes, DEFAULT_PARSER_LIMITS, { enabled: true, maxPreviewPages: 3 },
    );
    const preview = renders.previews.find(p => p.physicalPageIndex === task.physicalPageIndex);
    if (!preview || preview.sourceSha256 !== task.sourcePdfSha256 ||
        preview.pngSha256 !== task.sourcePngSha256) fail();
    const reviewer = createGatewayPdfGraphModelReviewer({
      gateway: deps.gateway, workspaceId: task.workspaceId, userId: task.userId,
      sourceDocumentId: task.sourceDocumentId, ingestionRunId: task.ingestionRunId,
      reviewRequestId: task.requestId, enabled: true,
    });
    return reviewer.review({
      physicalPageIndex: task.physicalPageIndex,
      sourceSha256: preview.sourceSha256, pngSha256: preview.pngSha256,
      pngBytes: preview.pngBytes, width: preview.width, height: preview.height,
      candidateJson: task.candidateJson, candidateSha256: task.candidateSha256,
      sourceTextExcerpt: task.sourceTextExcerpt,
      sourceTextPreviewTruncated: task.sourceTextPreviewTruncated,
      explicitSecondCallConsent: true,
    });
  };
}

/** An operator may deliberately construct this opt-in runtime. It is NOT
 * imported or started by startWorkerRuntime; no cron, queue, or automatic
 * paid service calls. Caller MUST close to drain in-flight Gateway + S3. */
export function createOnDemandPdfGraphSecondReviewRuntime(
  environment: Environment, source: NodeJS.ProcessEnv,
) {
  if (source.PDF_GRAPH_SECOND_REVIEW_REQUEST_ENABLED !== "true")
    throw Error("PDF_SECOND_REVIEW_EXECUTION_DISABLED");
  const storage = new S3CompatibleStorageProvider({
    endpoint:environment.S3_ENDPOINT, region:environment.S3_REGION,
    bucket:environment.S3_BUCKET, accessKey:environment.S3_ACCESS_KEY,
    secretKey:environment.S3_SECRET_KEY,
    forcePathStyle:environment.S3_FORCE_PATH_STYLE,
  });
  let gatewayRuntime: ReturnType<typeof createBookProductionGatewayRuntime>;
  try { gatewayRuntime = createBookProductionGatewayRuntime(source); }
  catch (e) { storage.close(); throw e; }
  const managed = createManagedPdfVisualReviewRuntime(
    () => processNextPdfGraphSecondReviewRequest({
      enabled: true,
      execute: createPdfGraphSecondReviewExecutor({
        storage, gateway: gatewayRuntime.gateway,
      }),
      repository: gatewayRuntime.repository,
    }),
    async () => { try { storage.close(); } finally { await gatewayRuntime.close(); } },
  );
  return {
    executeOnce: () => managed.execute(undefined),
    close: () => managed.close(),
  };
}
