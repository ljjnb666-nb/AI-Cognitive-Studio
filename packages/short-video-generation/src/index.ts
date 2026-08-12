/* Durable, bounded short-video generation. Source text remains data throughout. */
/* The generated Prisma include shapes are deliberately narrowed incrementally in this new package. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { prisma } from "@ai-cognitive/db";
import {
  buildBookContextForIntelligence,
  estimateAnalysisTokens,
  type EmbeddingProvider,
} from "@ai-cognitive/book-intelligence";
import { dispatchPendingOutbox } from "@ai-cognitive/ingestion";
import type { StorageProvider } from "@ai-cognitive/storage";

const execute = promisify(execFile);
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
export const SHORT_VIDEO_GENERATION_JOB = "short-video.generation";
export const SHORT_VIDEO_GENERATION_TOPIC = "short-video.generation.requested";
export const SHORT_VIDEO_PROVIDER_INPUT_BUDGET = 4_000;
export const SHORT_VIDEO_SCENE_TYPES = [
  "HOOK",
  "QUESTION",
  "CLAIM",
  "CONTRAST",
  "EVIDENCE",
  "QUOTE",
  "CONCEPT",
  "LIST",
  "DIAGRAM",
  "REFRAME",
  "CALLBACK",
  "ENDING",
] as const;
const text = (max: number) => z.string().trim().min(1).max(max);
export const shortVideoPlanSchema = z.object({
  centralQuestion: text(600),
  viewerAssumption: text(900),
  coreInsight: text(900),
  cognitiveShift: text(900),
  hook: text(280),
  supportingIdeas: z.array(text(500)).min(1).max(12),
  evidenceStrategy: text(900),
  ending: text(400),
  targetDurationSeconds: z.number().int().min(15).max(80),
  tone: text(200),
});
export const shortVideoSceneSchema = z.object({
  ordinal: z.number().int().positive(),
  sceneType: z.enum(SHORT_VIDEO_SCENE_TYPES),
  targetDurationMs: z.number().int().min(700).max(20_000),
  narrationText: text(900),
  visualIntent: text(500),
  primaryText: text(180),
  secondaryText: z.string().trim().max(280).optional(),
  keywords: z.array(text(80)).max(8),
  layoutTemplate: z.enum([
    "QUESTION_CARD",
    "CLAIM_CARD",
    "CONTRAST",
    "EVIDENCE_CARD",
    "CONCEPT_CARD",
    "ENDING_CARD",
  ]),
  motionPreset: z.enum(["REVEAL", "ZOOM", "SLIDE", "HOLD"]),
  transitionIntent: z.enum(["CUT", "FADE", "WIPE"]),
  evidence: z
    .array(
      z.object({
        sourceBlockId: text(128),
        startOffset: z.number().int().nonnegative(),
        endOffset: z.number().int().positive(),
      }),
    )
    .max(8),
});
export const shortVideoScenesSchema = z.object({
  scenes: z.array(shortVideoSceneSchema).min(6).max(24),
});
export type ShortVideoProvider = {
  identity: { provider: string; model: string; modelVersion?: string };
  plan(input: unknown): Promise<unknown>;
  scenes(input: unknown): Promise<unknown>;
};
export type ShortVideoTtsProvider = {
  identity: { provider: string; model: string; voiceIdentity: string };
  synthesize(input: {
    text: string;
    language: string;
  }): Promise<{ bytes: Uint8Array; mediaType: string; durationMs: number }>;
};
export type TrustedRequestContext = { workspaceId: string; userId: string };

async function membership(context: TrustedRequestContext) {
  if (
    !(await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: context },
    }))
  )
    throw new Error("WORKSPACE_ACCESS_DENIED");
}
export async function createShortVideoProject(
  context: TrustedRequestContext,
  input: { name: string; description?: string; sourceDocumentIds: string[] },
) {
  await membership(context);
  const ids = [...new Set(input.sourceDocumentIds)];
  if (!ids.length) throw new Error("SHORT_VIDEO_PROJECT_SOURCE_REQUIRED");
  const documents = await prisma.sourceDocument.findMany({
    where: { workspaceId: context.workspaceId, id: { in: ids } },
  });
  if (documents.length !== ids.length)
    throw new Error("SOURCE_DOCUMENT_ACCESS_DENIED");
  return prisma.$transaction(async (tx) => {
    const project = await tx.shortVideoProject.create({
      data: {
        workspaceId: context.workspaceId,
        name: input.name,
        description: input.description,
      },
    });
    await tx.shortVideoProjectSource.createMany({
      data: ids.map((sourceDocumentId) => ({
        shortVideoProjectId: project.id,
        sourceDocumentId,
        workspaceId: context.workspaceId,
      })),
    });
    await tx.shortVideoStyleProfile.create({
      data: {
        workspaceId: context.workspaceId,
        shortVideoProjectId: project.id,
        version: 1,
      },
    });
    return project;
  });
}
export async function configureShortVideoStyle(
  context: TrustedRequestContext,
  projectId: string,
  input: Partial<{
    language: string;
    tone: string;
    pace: number;
    hookStyle: string;
    informationDensity: number;
    sentenceStyle: string;
    captionDensity: number;
    visualDensity: number;
    keywordEmphasis: number;
    transitionIntensity: number;
    textAnimationIntensity: number;
    endingStyle: string;
    targetDurationSeconds: number;
    safeArea: object;
  }>,
) {
  await membership(context);
  const previous = await prisma.shortVideoStyleProfile.findFirst({
    where: { workspaceId: context.workspaceId, shortVideoProjectId: projectId },
    orderBy: { version: "desc" },
  });
  if (!previous) throw new Error("SHORT_VIDEO_PROJECT_NOT_FOUND");
  const duration =
    input.targetDurationSeconds ?? previous.targetDurationSeconds;
  if (!Number.isInteger(duration) || duration < 15 || duration > 80)
    throw new Error("SHORT_VIDEO_DURATION_INVALID");
  return prisma.shortVideoStyleProfile.create({
    data: {
      workspaceId: context.workspaceId,
      shortVideoProjectId: projectId,
      version: previous.version + 1,
      language: input.language ?? previous.language,
      tone: input.tone ?? previous.tone,
      pace: input.pace ?? previous.pace,
      hookStyle: input.hookStyle ?? previous.hookStyle,
      informationDensity:
        input.informationDensity ?? previous.informationDensity,
      sentenceStyle: input.sentenceStyle ?? previous.sentenceStyle,
      captionDensity: input.captionDensity ?? previous.captionDensity,
      visualDensity: input.visualDensity ?? previous.visualDensity,
      keywordEmphasis: input.keywordEmphasis ?? previous.keywordEmphasis,
      transitionIntensity:
        input.transitionIntensity ?? previous.transitionIntensity,
      textAnimationIntensity:
        input.textAnimationIntensity ?? previous.textAnimationIntensity,
      endingStyle: input.endingStyle ?? previous.endingStyle,
      targetDurationSeconds: duration,
      safeArea: (input.safeArea ?? previous.safeArea ?? {}) as object,
    },
  });
}
export async function requestShortVideoGeneration(
  context: TrustedRequestContext,
  input: {
    shortVideoProjectId: string;
    provider: string;
    model: string;
    modelVersion?: string;
    pipelineVersion: string;
    promptVersion: string;
    retrievalVersion: string;
    scenePlannerVersion: string;
    captionVersion: string;
    audioVersion: string;
    renderVersion: string;
    styleProfileId?: string;
    correlationId?: string;
  },
) {
  await membership(context);
  const project = await prisma.shortVideoProject.findFirstOrThrow({
    where: { id: input.shortVideoProjectId, workspaceId: context.workspaceId },
    include: {
      sources: true,
      styleProfiles: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  const style = input.styleProfileId
    ? await prisma.shortVideoStyleProfile.findFirstOrThrow({
        where: {
          id: input.styleProfileId,
          shortVideoProjectId: project.id,
          workspaceId: context.workspaceId,
        },
      })
    : project.styleProfiles[0];
  if (!style) throw new Error("SHORT_VIDEO_STYLE_REQUIRED");
  const sourceIds = project.sources.map((x) => x.sourceDocumentId).sort();
  const current = await prisma.currentBookIntelligence.findMany({
    where: {
      workspaceId: context.workspaceId,
      sourceDocumentId: { in: sourceIds },
    },
  });
  if (current.length !== sourceIds.length)
    throw new Error("CURRENT_BOOK_INTELLIGENCE_REQUIRED");
  const identity = sha256(
    stable([
      project.id,
      style.id,
      style.version,
      current
        .map((x) => [
          x.sourceDocumentId,
          x.extractionId,
          x.chunkSetId,
          x.analysisRunId,
        ])
        .sort(),
      input.provider,
      input.model,
      input.modelVersion ?? "",
      input.pipelineVersion,
      input.promptVersion,
      input.retrievalVersion,
      input.scenePlannerVersion,
      input.captionVersion,
      input.audioVersion,
      input.renderVersion,
    ]),
  );
  const existing = await prisma.shortVideoGenerationRun.findUnique({
    where: {
      shortVideoProjectId_generationIdentityHash: {
        shortVideoProjectId: project.id,
        generationIdentityHash: identity,
      },
    },
    include: { job: true },
  });
  if (existing) return { run: existing, job: existing.job };
  try {
    return await prisma.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: {
          workspaceId: context.workspaceId,
          userId: context.userId,
          type: SHORT_VIDEO_GENERATION_JOB,
          payload: { shortVideoProjectId: project.id },
          idempotencyKey: `short-video:${identity}`,
          correlationId: input.correlationId,
        },
      });
      const run = await tx.shortVideoGenerationRun.create({
        data: {
          workspaceId: context.workspaceId,
          shortVideoProjectId: project.id,
          styleProfileId: style.id,
          jobId: job.id,
          provider: input.provider,
          model: input.model,
          modelVersion: input.modelVersion,
          modelVersionKey: input.modelVersion ?? "",
          promptVersion: input.promptVersion,
          pipelineVersion: input.pipelineVersion,
          retrievalVersion: input.retrievalVersion,
          scenePlannerVersion: input.scenePlannerVersion,
          captionVersion: input.captionVersion,
          audioVersion: input.audioVersion,
          renderVersion: input.renderVersion,
          generationIdentityHash: identity,
          idempotencyKey: `short-video:${identity}`,
          correlationId: input.correlationId,
        },
      });
      await tx.shortVideoGenerationSource.createMany({
        data: current.map((x) => ({
          shortVideoGenerationRunId: run.id,
          workspaceId: context.workspaceId,
          shortVideoProjectId: project.id,
          sourceDocumentId: x.sourceDocumentId,
          extractionId: x.extractionId,
          chunkSetId: x.chunkSetId,
          analysisRunId: x.analysisRunId,
        })),
      });
      await tx.outboxEvent.create({
        data: {
          topic: SHORT_VIDEO_GENERATION_TOPIC,
          aggregateId: run.id,
          payload: { shortVideoGenerationRunId: run.id },
        },
      });
      return { run, job };
    });
  } catch (error) {
    const recovered = await prisma.shortVideoGenerationRun.findUnique({
      where: {
        shortVideoProjectId_generationIdentityHash: {
          shortVideoProjectId: project.id,
          generationIdentityHash: identity,
        },
      },
      include: { job: true },
    });
    if (!recovered) throw error;
    return { run: recovered, job: recovered.job };
  }
}

async function claim(runId: string, token: string) {
  const rows = await prisma.$queryRaw<
    Array<{ jobId: string }>
  >`UPDATE "ShortVideoGenerationRun" SET "status"='RUNNING'::"ShortVideoGenerationStatus", "stage"=CASE WHEN "stage"='QUEUED'::"ShortVideoGenerationStage" THEN 'CONTEXT_RETRIEVAL'::"ShortVideoGenerationStage" ELSE "stage" END, "startedAt"=COALESCE("startedAt", NOW()), "executionClaimToken"=${token}, "executionClaimedAt"=NOW(), "executionLeaseUntil"=NOW()+INTERVAL '2 minutes', "errorCode"=NULL WHERE "id"=${runId} AND "status" <> 'SUCCEEDED'::"ShortVideoGenerationStatus" AND ("executionClaimToken" IS NULL OR "executionLeaseUntil" < NOW()) RETURNING "jobId"`;
  if (!rows.length) return false;
  await prisma.job.update({
    where: { id: rows[0]!.jobId },
    data: {
      status: "RUNNING",
      attemptCount: { increment: 1 },
      startedAt: new Date(),
    },
  });
  return true;
}
async function stage(
  runId: string,
  token: string,
  expected: string,
  next: string,
) {
  const changed =
    await prisma.$executeRaw`UPDATE "ShortVideoGenerationRun" SET "stage"=CAST(${next} AS "ShortVideoGenerationStage") WHERE "id"=${runId} AND "executionClaimToken"=${token} AND "executionLeaseUntil">NOW() AND "status"='RUNNING'::"ShortVideoGenerationStatus" AND "stage"=CAST(${expected} AS "ShortVideoGenerationStage")`;
  if (changed !== 1) throw new Error("SHORT_VIDEO_OWNERSHIP_LOST");
}
async function owned<T>(
  runId: string,
  token: string,
  work: (tx: any) => Promise<T>,
) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT "id" FROM "ShortVideoGenerationRun" WHERE "id"=${runId} AND "executionClaimToken"=${token} AND "executionLeaseUntil">NOW() AND "status"='RUNNING'::"ShortVideoGenerationStatus" FOR UPDATE`;
    if (!rows.length) throw new Error("SHORT_VIDEO_OWNERSHIP_LOST");
    return work(tx);
  });
}
async function load(runId: string) {
  return prisma.shortVideoGenerationRun.findUniqueOrThrow({
    where: { id: runId },
    include: {
      sources: true,
      styleProfile: true,
      project: true,
      plan: true,
      scenes: { orderBy: { ordinal: "asc" } },
      narration: { orderBy: { ordinal: "asc" } },
      audioArtifacts: true,
      renderArtifact: true,
    },
  });
}
function boundedSynthesisUnits(value: string, maximum = 420) {
  const units: string[] = [];
  let remaining = value.trim();
  while (remaining.length > maximum) {
    const boundary = Math.max(
      remaining.lastIndexOf("。", maximum),
      remaining.lastIndexOf(". ", maximum),
      remaining.lastIndexOf("，", maximum),
      remaining.lastIndexOf(" ", maximum),
    );
    const cut = boundary > 0 ? boundary + 1 : maximum;
    units.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) units.push(remaining);
  return units;
}
async function synthesizeNarration(
  run: any,
  token: string,
  dependencies: { tts: ShortVideoTtsProvider; storage: StorageProvider },
) {
  for (const narration of run.narration) {
    for (const [unitOrdinal, unit] of boundedSynthesisUnits(
      narration.text,
    ).entries()) {
      const identity = sha256(
        stable([
          run.id,
          narration.id,
          narration.textHash,
          unitOrdinal,
          sha256(unit),
          dependencies.tts.identity,
        ]),
      );
      if (
        await prisma.shortVideoAudioArtifact.findUnique({
          where: {
            shortVideoGenerationRunId_synthesisIdentityHash: {
              shortVideoGenerationRunId: run.id,
              synthesisIdentityHash: identity,
            },
          },
        })
      )
        continue;
      const response = await dependencies.tts.synthesize({
        text: unit,
        language: narration.language,
      });
      if (
        !response.bytes.length ||
        response.bytes.length > 20 * 1024 * 1024 ||
        response.durationMs <= 0 ||
        response.durationMs > 120_000
      )
        throw new Error("SHORT_VIDEO_TTS_OUTPUT_INVALID");
      const hash = sha256(response.bytes),
        key = `short-video-orphans/${run.workspaceId}/${run.id}/narration/${identity}-${hash}`;
      await dependencies.storage.putObject({
        key,
        body: response.bytes,
        contentType: response.mediaType,
      });
      await owned(run.id, token, (tx) =>
        tx.shortVideoAudioArtifact.create({
          data: {
            shortVideoGenerationRunId: run.id,
            sceneId: narration.sceneId,
            synthesisIdentityHash: identity,
            storageKey: key,
            sha256: hash,
            sizeBytes: response.bytes.length,
            mediaType: response.mediaType,
            durationMs: response.durationMs,
            provider: dependencies.tts.identity.provider,
            model: dependencies.tts.identity.model,
            voiceIdentity: dependencies.tts.identity.voiceIdentity,
          },
        }),
      );
    }
  }
}
async function context(run: any, embeddingProvider: EmbeddingProvider) {
  const result: any[] = [];
  for (const source of run.sources) {
    const pack = await buildBookContextForIntelligence({
      workspaceId: run.workspaceId,
      sourceDocumentId: source.sourceDocumentId,
      extractionId: source.extractionId,
      chunkSetId: source.chunkSetId,
      analysisRunId: source.analysisRunId,
      task: `Create a grounded short video about ${run.project.name}`,
      tokenBudget: Math.floor(
        SHORT_VIDEO_PROVIDER_INPUT_BUDGET / run.sources.length,
      ),
      embeddingProvider,
    });
    if (pack.lineage.analysisRunId !== source.analysisRunId)
      throw new Error("SHORT_VIDEO_PINNED_LINEAGE_MISMATCH");
    result.push(...pack.items.map((item) => ({ ...item, source })));
  }
  const tokens = result.reduce(
    (n, item) => n + estimateAnalysisTokens(item.content),
    0,
  );
  if (tokens > SHORT_VIDEO_PROVIDER_INPUT_BUDGET || !result.length)
    throw new Error("SHORT_VIDEO_CONTEXT_BUDGET_VIOLATION");
  result.sort((left, right) => right.evidence.length - left.evidence.length);
  return result.map((item) => ({
    memoryItemId: item.memoryItemId,
    content: item.content,
    tokenEstimate: estimateAnalysisTokens(item.content),
    evidence: item.evidence,
    source: item.source,
  }));
}
function assertBudget(input: unknown) {
  if (
    estimateAnalysisTokens(JSON.stringify(input)) >
    SHORT_VIDEO_PROVIDER_INPUT_BUDGET
  )
    throw new Error("SHORT_VIDEO_PROVIDER_INPUT_BUDGET_EXCEEDED");
}
function assertScenes(
  scenes: z.infer<typeof shortVideoScenesSchema>["scenes"],
  duration: number,
) {
  if (
    scenes.some((s, i) => s.ordinal !== i + 1) ||
    scenes.reduce((n, s) => n + s.targetDurationMs, 0) > duration * 1_150 ||
    scenes.some((s) =>
      /^(首先|其次|最后|总结|总之|综上|让我们)/.test(s.narrationText),
    )
  )
    throw new Error("SHORT_VIDEO_SCENE_QUALITY_INVALID");
}
export async function processShortVideoGenerationRun(
  runId: string,
  dependencies: {
    provider: ShortVideoProvider;
    embeddingProvider: EmbeddingProvider;
    tts: ShortVideoTtsProvider;
    storage: StorageProvider;
    renderer?: VideoRenderer;
    renderConfiguration?: { width: number; height: number; fps: number };
  },
) {
  let run = await load(runId);
  if (run.status === "SUCCEEDED") return run;
  if (
    dependencies.provider.identity.provider !== run.provider ||
    dependencies.provider.identity.model !== run.model ||
    (dependencies.provider.identity.modelVersion ?? "") !== run.modelVersionKey
  )
    throw new Error("SHORT_VIDEO_PROVIDER_IDENTITY_MISMATCH");
  const token = randomUUID();
  if (!(await claim(run.id, token))) {
    run = await load(run.id);
    if (run.status === "SUCCEEDED") return run;
    throw new Error("SHORT_VIDEO_ALREADY_CLAIMED");
  }
  try {
    while (true) {
      run = await load(run.id);
      if (run.stage === "CONTEXT_RETRIEVAL") {
        await context(run, dependencies.embeddingProvider);
        await stage(run.id, token, "CONTEXT_RETRIEVAL", "VIDEO_PLANNING");
      } else if (run.stage === "VIDEO_PLANNING") {
        if (!run.plan) {
          const bounded = await context(run, dependencies.embeddingProvider);
          const input = {
            style: run.styleProfile,
            context: bounded,
            targetDurationSeconds: run.styleProfile.targetDurationSeconds,
          };
          assertBudget(input);
          const plan = shortVideoPlanSchema.parse(
            await dependencies.provider.plan(input),
          );
          await owned(run.id, token, (tx) =>
            tx.shortVideoPlan.create({
              data: {
                shortVideoGenerationRunId: run.id,
                workspaceId: run.workspaceId,
                ...plan,
              },
            }),
          );
        }
        await stage(run.id, token, "VIDEO_PLANNING", "NARRATIVE_GENERATION");
      } else if (run.stage === "NARRATIVE_GENERATION") {
        await stage(run.id, token, "NARRATIVE_GENERATION", "SCENE_PLANNING");
      } else if (run.stage === "SCENE_PLANNING") {
        if (!run.scenes.length) {
          const bounded = await context(run, dependencies.embeddingProvider);
          const input = {
            style: run.styleProfile,
            plan: run.plan,
            context: bounded,
          };
          assertBudget(input);
          const scenes = shortVideoScenesSchema.parse(
            await dependencies.provider.scenes(input),
          ).scenes;
          assertScenes(scenes, run.styleProfile.targetDurationSeconds * 1000);
          const evidenceSources = new Map<string, any>();
          for (const item of bounded) for (const evidence of item.evidence) evidenceSources.set(evidence.sourceBlockId, item.source);
          await owned(run.id, token, async (tx) => {
            let offset = 0;
            for (const scene of scenes) {
              if (scene.evidence.some((e) => !evidenceSources.has(e.sourceBlockId)))
                throw new Error("SHORT_VIDEO_EVIDENCE_LINEAGE_INVALID");
              const created = await tx.shortVideoScene.create({
                data: {
                  shortVideoGenerationRunId: run.id,
                  workspaceId: run.workspaceId,
                  shortVideoProjectId: run.shortVideoProjectId,
                  ordinal: scene.ordinal,
                  sceneType: scene.sceneType,
                  targetStartMs: offset,
                  targetEndMs: offset + scene.targetDurationMs,
                  targetDurationMs: scene.targetDurationMs,
                  narrationText: scene.narrationText,
                  visualIntent: scene.visualIntent,
                  primaryText: scene.primaryText,
                  secondaryText: scene.secondaryText,
                  keywords: scene.keywords,
                  layoutTemplate: scene.layoutTemplate,
                  motionPreset: scene.motionPreset,
                  transitionIntent: scene.transitionIntent,
                },
              });
              await tx.shortVideoNarration.create({
                data: {
                  shortVideoGenerationRunId: run.id,
                  sceneId: created.id,
                  ordinal: scene.ordinal,
                  text: scene.narrationText,
                  textHash: sha256(scene.narrationText),
                  language: run.styleProfile.language,
                  estimatedDurationMs: scene.targetDurationMs,
                },
              });
              for (const evidence of scene.evidence) {
                const source = evidenceSources.get(evidence.sourceBlockId);
                await tx.shortVideoNarrationEvidence.create({
                  data: {
                    shortVideoGenerationRunId: run.id,
                    sceneId: created.id,
                    workspaceId: run.workspaceId,
                    sourceDocumentId: source.sourceDocumentId,
                    extractionId: source.extractionId,
                    chunkSetId: source.chunkSetId,
                    analysisRunId: source.analysisRunId,
                    sourceBlockId: evidence.sourceBlockId,
                    startOffset: evidence.startOffset,
                    endOffset: evidence.endOffset,
                  },
                });
              }
              offset += scene.targetDurationMs;
            }
          });
        }
        await stage(run.id, token, "SCENE_PLANNING", "NARRATION_SYNTHESIS");
      } else if (run.stage === "NARRATION_SYNTHESIS") {
        await synthesizeNarration(run, token, dependencies);
        await stage(run.id, token, "NARRATION_SYNTHESIS", "VISUAL_PREPARATION");
      } else if (run.stage === "VISUAL_PREPARATION") {
        const existing = await prisma.shortVideoVisualAsset.count({ where: { shortVideoGenerationRunId: run.id } });
        if (!existing) await owned(run.id, token, (tx) => tx.shortVideoVisualAsset.createMany({
          data: run.scenes.map((scene: any) => ({
            shortVideoGenerationRunId: run.id,
            sceneId: scene.id,
            kind: "DETERMINISTIC_EDITORIAL_FRAME",
            templateId: scene.layoutTemplate,
            metadata: { sceneType: scene.sceneType, primaryText: scene.primaryText, secondaryText: scene.secondaryText, keywords: scene.keywords, motionPreset: scene.motionPreset },
          })),
        }));
        await stage(run.id, token, "VISUAL_PREPARATION", "CAPTION_GENERATION");
      } else if (run.stage === "CAPTION_GENERATION") {
        const existing = await prisma.shortVideoCaptionCue.count({
          where: { shortVideoGenerationRunId: run.id },
        });
        if (!existing)
          await owned(run.id, token, (tx) =>
            tx.shortVideoCaptionCue.createMany({
              data: run.scenes.map((scene: any) => ({
                shortVideoGenerationRunId: run.id,
                sceneId: scene.id,
                ordinal: scene.ordinal,
                startMs: scene.targetStartMs,
                endMs: scene.targetEndMs,
                text: scene.narrationText,
                emphasis: { keywords: scene.keywords },
              })),
            }),
          );
        await stage(run.id, token, "CAPTION_GENERATION", "VIDEO_RENDERING");
      } else if (run.stage === "VIDEO_RENDERING") {
        if (!run.renderArtifact) {
          const renderer = dependencies.renderer ?? new FfmpegVideoRenderer();
          const narrationAudio = await Promise.all(run.audioArtifacts.map(async (artifact: any) => {
            if (!artifact.sceneId) throw new Error("SHORT_VIDEO_NARRATION_AUDIO_MISSING");
            const bytes = await dependencies.storage.getObjectBytes(artifact.storageKey);
            if (sha256(bytes) !== artifact.sha256) throw new Error("SHORT_VIDEO_STORAGE_HASH_MISMATCH");
            return { sceneId: artifact.sceneId, bytes, mediaType: artifact.mediaType, durationMs: artifact.durationMs };
          }));
          const output = await renderer.render({
            durationMs: run.scenes.reduce(
              (n: number, x: any) => n + x.targetDurationMs,
              0,
            ),
            width: dependencies.renderConfiguration?.width ?? (process.env.NODE_ENV === "test" ? 360 : 1080),
            height: dependencies.renderConfiguration?.height ?? (process.env.NODE_ENV === "test" ? 640 : 1920),
            fps: dependencies.renderConfiguration?.fps ?? (process.env.NODE_ENV === "test" ? 15 : 30),
            scenes: run.scenes.map((scene: any) => ({ id: scene.id, ordinal: scene.ordinal, sceneType: scene.sceneType, startMs: scene.targetStartMs, endMs: scene.targetEndMs, primaryText: scene.primaryText, secondaryText: scene.secondaryText, keywords: scene.keywords, layoutTemplate: scene.layoutTemplate, transitionIntent: scene.transitionIntent })),
            captions: await prisma.shortVideoCaptionCue.findMany({ where: { shortVideoGenerationRunId: run.id }, orderBy: { ordinal: "asc" } }),
            narrationAudio,
          });
          const bytes = await readFile(output.path);
          const hash = sha256(bytes);
          const key = `short-videos/${run.workspaceId}/${run.id}/${hash}.mp4`;
          await dependencies.storage.putObject({
            key,
            body: bytes,
            contentType: "video/mp4",
          });
          await owned(run.id, token, (tx) =>
            tx.shortVideoRenderArtifact.create({
              data: {
                shortVideoGenerationRunId: run.id,
                storageKey: key,
                sha256: hash,
                sizeBytes: bytes.length,
                mediaType: "video/mp4",
                container: "mp4",
                width: output.width,
                height: output.height,
                fps: output.fps,
                durationMs: output.durationMs,
                videoCodec: "h264",
                audioCodec: "aac",
              },
            }),
          );
          await output.cleanup();
        }
        await stage(run.id, token, "VIDEO_RENDERING", "QUALITY_VALIDATION");
      } else if (run.stage === "QUALITY_VALIDATION") {
        const artifact =
          await prisma.shortVideoRenderArtifact.findUniqueOrThrow({
            where: { shortVideoGenerationRunId: run.id },
          });
        const actual = await dependencies.storage.getObjectBytes(
          artifact.storageKey,
        );
        const captions = await prisma.shortVideoCaptionCue.findMany({ where: { shortVideoGenerationRunId: run.id }, orderBy: { ordinal: "asc" } });
        const probe = await probeMp4(actual);
        const hardFailures = [
          sha256(actual) !== artifact.sha256 ? "SHA_MISMATCH" : "",
          !probe.ok ? "MP4_UNDECODABLE" : "",
          probe.durationMs <= 0 ? "DURATION_INVALID" : "",
          probe.width <= 0 || probe.height <= 0 ? "DIMENSIONS_INVALID" : "",
          artifact.width * 16 !== artifact.height * 9
            ? "ASPECT_RATIO_INVALID"
            : "",
          !run.scenes.length ? "SCENES_MISSING" : "",
          !probe.hasAac ? "AUDIO_STREAM_MISSING" : "",
          run.scenes.some((scene: any, index: number) => scene.ordinal !== index + 1 || scene.targetEndMs <= scene.targetStartMs || (index > 0 && scene.targetStartMs < run.scenes[index - 1]!.targetEndMs) || scene.targetEndMs > probe.durationMs + 750) ? "SCENE_TIMING_INVALID" : "",
          captions.some((cue: any) => cue.endMs <= cue.startMs || cue.startMs < 0 || cue.endMs > probe.durationMs + 750) ? "CAPTION_TIMING_INVALID" : "",
          Math.abs(probe.durationMs - artifact.durationMs) > 1_000 ? "RENDER_DURATION_MISMATCH" : "",
        ].filter(Boolean);
        const warnings = evaluateWarnings(run.scenes, captions);
        if (hardFailures.length)
          throw new Error(`SHORT_VIDEO_QUALITY_FAILED:${hardFailures[0]}`);
        await owned(run.id, token, async (tx) => {
          const evaluation = await tx.shortVideoEvaluationRun.upsert({
            where: {
              shortVideoGenerationRunId_evaluatorVersion: {
                shortVideoGenerationRunId: run.id,
                evaluatorVersion: "phase5-deterministic-v1",
              },
            },
            create: {
              shortVideoGenerationRunId: run.id,
              evaluatorVersion: "phase5-deterministic-v1",
              status: "SUCCEEDED",
              completedAt: new Date(),
            },
            update: {
              status: "SUCCEEDED",
              completedAt: new Date(),
              errorCode: null,
            },
          });
          await tx.shortVideoEvaluationResult.upsert({
            where: { evaluationRunId: evaluation.id },
            create: {
              evaluationRunId: evaluation.id,
              metrics: {
                sceneCount: run.scenes.length,
                durationMs: artifact.durationMs,
              },
              hardFailures,
              warnings,
            },
            update: {
              metrics: {
                sceneCount: run.scenes.length,
                durationMs: artifact.durationMs,
              },
              hardFailures,
              warnings,
            },
          });
        });
        await stage(run.id, token, "QUALITY_VALIDATION", "FINALIZING");
      } else if (run.stage === "FINALIZING") {
        await owned(run.id, token, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "ShortVideoProject" WHERE "id"=${run.shortVideoProjectId} FOR UPDATE`;
          const artifact = await tx.shortVideoRenderArtifact.findUniqueOrThrow({
            where: { shortVideoGenerationRunId: run.id },
          });
          const revisionArtifact = {
            storageKey: artifact.storageKey, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes,
            mediaType: artifact.mediaType, container: artifact.container, width: artifact.width,
            height: artifact.height, fps: artifact.fps, durationMs: artifact.durationMs,
            videoCodec: artifact.videoCodec, audioCodec: artifact.audioCodec,
          };
          let revision = await tx.shortVideoRevision.findUnique({
            where: { generationRunId: run.id },
          });
          if (!revision) {
            const current = await tx.currentShortVideo.findUnique({
              where: { shortVideoProjectId: run.shortVideoProjectId },
              include: { revision: true },
            });
            revision = await tx.shortVideoRevision.create({
              data: {
                workspaceId: run.workspaceId,
                shortVideoProjectId: run.shortVideoProjectId,
                generationRunId: run.id,
                revisionNumber: (current?.revision.revisionNumber ?? 0) + 1,
                ...revisionArtifact,
              },
            });
            await tx.currentShortVideo.upsert({
              where: { shortVideoProjectId: run.shortVideoProjectId },
              create: {
                workspaceId: run.workspaceId,
                shortVideoProjectId: run.shortVideoProjectId,
                revisionId: revision.id,
              },
              update: { revisionId: revision.id },
            });
          }
          const changed =
            await tx.$executeRaw`UPDATE "ShortVideoGenerationRun" SET "status"='SUCCEEDED'::"ShortVideoGenerationStatus", "stage"='COMPLETED'::"ShortVideoGenerationStage", "completedAt"=NOW(), "executionClaimToken"=NULL, "executionClaimedAt"=NULL, "executionLeaseUntil"=NULL WHERE "id"=${run.id} AND "executionClaimToken"=${token} AND "stage"='FINALIZING'::"ShortVideoGenerationStage"`;
          if (changed !== 1) throw new Error("SHORT_VIDEO_OWNERSHIP_LOST");
          await tx.job.update({
            where: { id: run.jobId },
            data: {
              status: "SUCCEEDED",
              progress: 100,
              completedAt: new Date(),
              result: {
                shortVideoGenerationRunId: run.id,
                revisionId: revision.id,
              },
            },
          });
        });
        break;
      } else if (run.stage === "COMPLETED") break;
      else throw new Error(`SHORT_VIDEO_STAGE_INVALID:${run.stage}`);
    }
    return load(run.id);
  } catch (error) {
    const code =
      error instanceof Error
        ? error.message.split(":")[0]!
        : "SHORT_VIDEO_GENERATION_FAILED";
    const failed = await prisma.$executeRaw`UPDATE "ShortVideoGenerationRun" SET "status"='FAILED'::"ShortVideoGenerationStatus", "errorCode"=${code}, "completedAt"=NOW(), "executionClaimToken"=NULL, "executionClaimedAt"=NULL, "executionLeaseUntil"=NULL WHERE "id"=${run.id} AND "executionClaimToken"=${token} AND "status"='RUNNING'::"ShortVideoGenerationStatus"`;
    if (failed === 1) await prisma.job.update({
      where: { id: run.jobId },
      data: { status: "FAILED", error: { code }, completedAt: new Date() },
    });
    throw error;
  }
}
export async function dispatchPendingShortVideoGeneration(
  queue: {
    add(
      name: string,
      payload: { shortVideoGenerationRunId: string },
      options: { jobId: string },
    ): Promise<unknown>;
  },
  aggregateIds?: string[],
) {
  return dispatchPendingOutbox<{ shortVideoGenerationRunId: string }>({
    topic: SHORT_VIDEO_GENERATION_TOPIC,
    queue,
    jobName: SHORT_VIDEO_GENERATION_JOB,
    parse: (payload) => {
      const id = (payload as { shortVideoGenerationRunId?: unknown })
        .shortVideoGenerationRunId;
      if (typeof id !== "string")
        throw new Error("SHORT_VIDEO_OUTBOX_PAYLOAD_INVALID");
      return { shortVideoGenerationRunId: id };
    },
    jobId: (payload) => payload.shortVideoGenerationRunId,
    aggregateIds,
    afterDispatch: async (tx, payload, queueJobId) => {
      const run = await prisma.shortVideoGenerationRun.findUniqueOrThrow({
        where: { id: payload.shortVideoGenerationRunId },
      });
      await tx.job.update({ where: { id: run.jobId }, data: { queueJobId } });
    },
  });
}
export interface VideoRenderer {
  render(input: {
    durationMs: number;
    width: number;
    height: number;
    fps: number;
    scenes: Array<{ id: string; ordinal: number; sceneType: string; startMs: number; endMs: number; primaryText: string; secondaryText?: string | null; keywords: unknown; layoutTemplate: string; transitionIntent: string }>;
    captions: Array<{ startMs: number; endMs: number; text: string }>;
    narrationAudio: Array<{ sceneId: string; bytes: Uint8Array; mediaType: string; durationMs: number }>;
  }): Promise<{
    path: string;
    width: number;
    height: number;
    fps: number;
    durationMs: number;
    cleanup(): Promise<void>;
  }>;
}
export class FfmpegVideoRenderer implements VideoRenderer {
  async render(input: {
    durationMs: number;
    width: number;
    height: number;
    fps: number;
    scenes: Array<{ id: string; ordinal: number; sceneType: string; startMs: number; endMs: number; primaryText: string; secondaryText?: string | null; keywords: unknown; layoutTemplate: string; transitionIntent: string }>;
    captions: Array<{ startMs: number; endMs: number; text: string }>;
    narrationAudio: Array<{ sceneId: string; bytes: Uint8Array; mediaType: string; durationMs: number }>;
  }) {
    if (
      input.durationMs <= 0 ||
      input.width <= 0 ||
      input.height <= 0 ||
      input.width * 16 !== input.height * 9 || !input.scenes.length || !input.narrationAudio.length
    )
      throw new Error("VIDEO_RENDER_INPUT_INVALID");
    const directory = await mkdtemp(
      join(tmpdir(), "ai-cognitive-short-video-"),
    );
    const output = join(directory, "render.mp4"), captions = join(directory, "captions.srt");
    try {
      const ordered = [...input.scenes].sort((a, b) => a.ordinal - b.ordinal);
      if (ordered.some((scene, index) => scene.ordinal !== index + 1 || scene.endMs <= scene.startMs || (index && scene.startMs < ordered[index - 1]!.endMs))) throw new Error("VIDEO_RENDER_SCENE_TIMING_INVALID");
      const audioByScene = new Map(input.narrationAudio.map((audio) => [audio.sceneId, audio]));
      if (ordered.some((scene) => !audioByScene.has(scene.id))) throw new Error("VIDEO_RENDER_NARRATION_MISSING");
      await writeFile(captions, input.captions.map((cue, index) => `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text.replace(/\r?\n/g, " ")}\n`).join("\n"), "utf8");
      const args = ["-y"];
      for (const [index, scene] of ordered.entries()) {
        const primary = join(directory, `scene-${index}-primary.txt`), secondary = join(directory, `scene-${index}-secondary.txt`);
        await writeFile(primary, scene.primaryText, "utf8"); await writeFile(secondary, scene.secondaryText ?? scene.sceneType, "utf8");
        const duration = ((scene.endMs - scene.startMs) / 1000).toFixed(3);
        const palette = ["#0f172a", "#172554", "#1e1b4b", "#312e81", "#3f1d2e", "#134e4a"][index % 6]!;
        const escapePath = (path: string) => path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
        const filter = `color=c=${palette}:s=${input.width}x${input.height}:r=${input.fps}:d=${duration},drawbox=x=70:y=250:w=${input.width - 140}:h=10:color=0x38bdf8@0.9:t=fill,drawtext=textfile='${escapePath(primary)}':fontcolor=white:fontsize=${Math.max(34, Math.floor(input.width / 11))}:x=(w-text_w)/2:y=h*0.32:line_spacing=12:enable='between(t,0.15,${duration})',drawtext=textfile='${escapePath(secondary)}':fontcolor=0x94a3b8:fontsize=${Math.max(22, Math.floor(input.width / 20))}:x=(w-text_w)/2:y=h*0.52:line_spacing=8`;
        args.push("-f", "lavfi", "-i", filter);
      }
      for (const [index, scene] of ordered.entries()) {
        const audio = audioByScene.get(scene.id)!;
        const extension = audio.mediaType.includes("mpeg") ? "mp3" : audio.mediaType.includes("wav") ? "wav" : "m4a";
        const audioPath = join(directory, `narration-${index}.${extension}`); await writeFile(audioPath, audio.bytes); args.push("-i", audioPath);
      }
      const videoInputs = ordered.map((_, index) => `[${index}:v]`).join("");
      const audioInputs = ordered.map((_, index) => `[${index + ordered.length}:a]`).join("");
      const escapedCaptions = captions.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
      await execute(
        "ffmpeg",
        [...args,
          "-filter_complex", `${videoInputs}concat=n=${ordered.length}:v=1:a=0[v];${audioInputs}concat=n=${ordered.length}:v=0:a=1[a];[v]subtitles='${escapedCaptions}'[captioned]`,
          "-map", "[captioned]", "-map", "[a]", "-shortest",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          output,
        ],
        { timeout: 120_000, maxBuffer: 1_000_000, windowsHide: true },
      );
      return {
        path: output,
        width: input.width,
        height: input.height,
        fps: input.fps,
        durationMs: (await probeMp4(await readFile(output))).durationMs,
        cleanup: () => rm(directory, { recursive: true, force: true }),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}

function srtTime(milliseconds: number) { const hours = Math.floor(milliseconds / 3_600_000); const minutes = Math.floor((milliseconds % 3_600_000) / 60_000); const seconds = Math.floor((milliseconds % 60_000) / 1_000); return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(milliseconds % 1000).padStart(3, "0")}`; }
async function probeMp4(bytes: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), "ai-cognitive-short-video-probe-")), path = join(directory, "artifact.mp4");
  try { await writeFile(path, bytes); const { stdout } = await execute("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration:stream=codec_name,codec_type,width,height", "-of", "json", path], { timeout: 30_000, maxBuffer: 500_000, windowsHide: true }); const value = JSON.parse(stdout) as any; const video = value.streams?.find((stream: any) => stream.codec_type === "video"); const audio = value.streams?.find((stream: any) => stream.codec_type === "audio"); return { ok: String(value.format?.format_name ?? "").includes("mp4") && video?.codec_name === "h264", durationMs: Math.round(Number(value.format?.duration ?? 0) * 1000), width: Number(video?.width ?? 0), height: Number(video?.height ?? 0), hasAac: audio?.codec_name === "aac" }; } catch { return { ok: false, durationMs: 0, width: 0, height: 0, hasAac: false }; } finally { await rm(directory, { recursive: true, force: true }); }
}
function evaluateWarnings(scenes: any[], captions: any[]) { const warnings: string[] = []; const joined = scenes.map((scene) => scene.narrationText).join(" "); if (scenes.some((scene) => scene.targetDurationMs < 1_000)) warnings.push("SCENE_TOO_SHORT"); if (scenes.some((scene) => scene.targetDurationMs > 12_000)) warnings.push("SCENE_TOO_LONG"); if (captions.reduce((total, cue) => total + cue.text.length, 0) > scenes.length * 260) warnings.push("CAPTION_DENSITY_HIGH"); if (/(首先|其次|最后|总结一下|总的来说|综上|让我们|今天我们来聊聊)/.test(joined)) warnings.push("AI_STYLE_PHRASE_OVERUSE"); if (scenes.length > 1 && scenes.every((scene) => scene.layoutTemplate === scenes[0].layoutTemplate)) warnings.push("REPEATED_LAYOUT"); return warnings; }
