import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";
import { findCrossBookCognitionConnections } from "../../lib/cognition-associations";

const password = "Phase13Password!";

async function signUp(page: Page, email: string) {
  await page.goto("/sign-up");
  await page.locator('input[name="name"]').fill("Phase Thirteen Reader");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  const response = page.waitForResponse(item => item.url().endsWith("/api/auth/sign-up/email"));
  await page.getByRole("button", { name: "注册并进入 Studio" }).click();
  expect((await response).status()).toBe(200);
  await expect(page).toHaveURL(/\/studio$/);
}

async function currentCognition(workspaceId: string, userId: string, label: string) {
  const suffix = randomUUID();
  const source = await prisma.source.create({ data: { workspaceId, kind: "FILE", displayName: `Phase 13 ${label}` } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId, sha256: suffix, sizeBytes: 1, mediaType: "text/plain", storageKey: `phase13/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/plain", storageKey: blob.storageKey } });
  const ingestJob = await prisma.job.create({ data: { workspaceId, userId, type: "source.ingest", status: "SUCCEEDED", payload: {} } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId, sourceDocumentId: document.id, jobId: ingestJob.id, parserVersion: "phase13", normalizationVersion: "phase13", status: "SUCCEEDED" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "phase13", parserVersion: "phase13", normalizationVersion: "phase13" } });
  const block = await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal: 0, kind: "PARAGRAPH", text: `Evidence ${label}`, contentHash: suffix } });
  await prisma.currentDocumentExtraction.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id } });
  const analysisJob = await prisma.job.create({ data: { workspaceId, userId, type: "book.analysis", status: "SUCCEEDED", payload: {} } });
  const chunkSet = await prisma.chunkSet.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "phase13", configuration: {}, configurationHash: suffix, status: "SUCCEEDED" } });
  const run = await prisma.bookAnalysisRun.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunkSet.id, jobId: analysisJob.id, pipelineVersion: "phase13", promptVersion: "phase13", provider: "fixture", model: "fixture", modelVersionKey: "fixture", idempotencyKey: `phase13:${suffix}`, analysisIdentityHash: `phase13:${suffix}`, status: "SUCCEEDED", analysisStage: "COMPLETED", completedAt: new Date() } });
  const artifact = await prisma.analysisArtifact.create({ data: { workspaceId, analysisRunId: run.id, chunkSetId: chunkSet.id, extractionId: extraction.id, scope: "BOOK", ordinal: 0, structuredOutput: {} } });
  const item = await prisma.bookMemoryItem.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, analysisRunId: run.id, sourceArtifactId: artifact.id, type: "SUMMARY", ordinal: 0, content: `Phase 13 cognition ${label}`, contentHash: suffix, memoryKey: `${run.id}:0` } });
  await prisma.bookMemoryEvidence.create({ data: { workspaceId, analysisRunId: run.id, extractionId: extraction.id, memoryItemId: item.id, sourceBlockId: block.id, startOffset: 0, endOffset: block.text.length } });
  await prisma.currentBookIntelligence.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunkSet.id, analysisRunId: run.id } });
  return { document, item, run };
}

async function assessed(workspaceId: string, userId: string, memoryItemId: string, masteryState: "NEEDS_REVIEW" | "DEVELOPING" | "DEMONSTRATED") {
  const assessedAt = new Date("2020-01-01T00:00:00.000Z"), attemptId = randomUUID();
  await prisma.userCognitionState.create({ data: { workspaceId, userId, memoryItemId, state: "SAVED" } });
  await prisma.teachBackAttempt.create({ data: { id: attemptId, workspaceId, userId, memoryItemId, content: masteryState, status: "ASSESSED", assessedAt } });
  await prisma.teachBackAssessment.create({ data: { workspaceId, attemptId, masteryState, rubric: masteryState === "NEEDS_REVIEW" ? [{ key: "COVERAGE", status: "NOT_MET" }] : [], feedback: "fixture", nextPrompt: null } });
  await prisma.userCognitionReviewState.create({ data: { workspaceId, userId, memoryItemId, lastMasteryState: masteryState, lastMasteryAssessedAt: assessedAt, lastReviewedAt: assessedAt, nextReviewAt: assessedAt } });
}

test("real auth keeps personalized cognition private, durable, current, and cross-book grounded", async ({ page, browser }) => {
  const email = `phase13-owner-${Date.now()}@ai-cognitive-studio.test`;
  await signUp(page, email);
  const owner = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const workspaceId = owner.memberships[0]!.workspaceId;
  const needs = await currentCognition(workspaceId, owner.id, "needs review");
  const developing = await currentCognition(workspaceId, owner.id, "developing");
  const demonstrated = await currentCognition(workspaceId, owner.id, "demonstrated");
  const unassessed = await currentCognition(workspaceId, owner.id, "unassessed");
  const untouched = await currentCognition(workspaceId, owner.id, "untouched");
  await assessed(workspaceId, owner.id, needs.item.id, "NEEDS_REVIEW");
  await assessed(workspaceId, owner.id, developing.item.id, "DEVELOPING");
  await assessed(workspaceId, owner.id, demonstrated.item.id, "DEMONSTRATED");
  const past = new Date("2020-01-01T00:00:00.000Z");
  await prisma.userCognitionState.create({ data: { workspaceId, userId: owner.id, memoryItemId: unassessed.item.id, state: "SAVED" } });
  await prisma.userCognitionReviewState.create({ data: { workspaceId, userId: owner.id, memoryItemId: unassessed.item.id, lastReviewedAt: past, nextReviewAt: past } });
  await prisma.bookMemoryEmbedding.createMany({ data: [
    { workspaceId, memoryItemId: needs.item.id, analysisRunId: needs.run.id, extractionId: needs.run.extractionId, provider: "fixture", model: "embedding", modelVersion: "v1", embeddingVersion: "v1", embeddingIdentityHash: `phase13-${randomUUID()}`, dimensions: 3, vector: [1, 0, 0] },
    { workspaceId, memoryItemId: developing.item.id, analysisRunId: developing.run.id, extractionId: developing.run.extractionId, provider: "fixture", model: "embedding", modelVersion: "v1", embeddingVersion: "v1", embeddingIdentityHash: `phase13-${randomUUID()}`, dimensions: 3, vector: [0.9, 0.1, 0] },
  ] });
  await expect(findCrossBookCognitionConnections({ workspaceId, userId: owner.id }, needs.item.id)).resolves.toEqual([expect.objectContaining({ id: developing.item.id })]);

  await page.goto("/studio/cognitions");
  await expect(page.locator("h1", { hasText: "我的认知" })).toBeVisible();
  for (const label of ["总认知 4", "待复习 4", "尚未验证 1", "需要复习 1", "正在形成 1", "已掌握 1"]) await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByText(untouched.item.content, { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: "全部认知" }).click();
  await expect(page.getByText(untouched.item.content, { exact: true })).toBeVisible();

  await page.goto("/studio/cognitions");
  const reviewRequests: Array<{ eventId: string }> = [];
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === `/api/studio/cognitions/${needs.item.id}/review`) reviewRequests.push(request.postDataJSON() as { eventId: string }); });
  const reviewed = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/studio/cognitions/${needs.item.id}/review`);
  await page.getByRole("button", { name: "标记已复习" }).first().click();
  expect((await reviewed).status()).toBe(200);
  expect(reviewRequests).toHaveLength(1);
  const reviewState = await prisma.userCognitionReviewState.findUniqueOrThrow({ where: { workspaceId_userId_memoryItemId: { workspaceId, userId: owner.id, memoryItemId: needs.item.id } } });
  expect(await prisma.userCognitionReviewEvent.count({ where: { id: reviewRequests[0]!.eventId } })).toBe(1);
  expect(reviewState.reviewCount).toBe(1);
  expect(reviewState.nextReviewAt!.getTime()).toBeGreaterThan(Date.now());
  expect(reviewState.lastMasteryState).toBe("NEEDS_REVIEW");
  await page.reload();
  await expect(page.getByRole("button", { name: "已记录复习" })).toHaveCount(0);

  await page.goto(`/studio/cognitions/${needs.item.id}`);
  await expect(page.getByRole("heading", { name: "跨书关联" })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(developing.item.content) })).toBeVisible();
  await prisma.currentBookIntelligence.delete({ where: { sourceDocumentId_workspaceId: { sourceDocumentId: developing.document.id, workspaceId } } });
  await page.reload();
  await expect(page.getByRole("link", { name: new RegExp(developing.item.content) })).toHaveCount(0);

  const memberContext = await browser.newContext(), memberPage = await memberContext.newPage();
  const memberEmail = `phase13-member-${Date.now()}@ai-cognitive-studio.test`;
  await signUp(memberPage, memberEmail);
  const member = await prisma.user.findUniqueOrThrow({ where: { email: memberEmail } });
  await prisma.workspaceMember.create({ data: { workspaceId, userId: member.id, role: "VIEWER" } });
  await prisma.user.update({ where: { id: member.id }, data: { defaultWorkspaceId: workspaceId } });
  await memberPage.goto("/studio/cognitions");
  await expect(memberPage.getByText(needs.item.content, { exact: true })).toHaveCount(0);
  const privateReview = await memberPage.request.post(`/api/studio/cognitions/${needs.item.id}/review`, { data: { eventId: randomUUID() } });
  expect(privateReview.status()).toBe(404);
  expect(await privateReview.json()).toEqual({ error: "COGNITION_NOT_FOUND" });
  await memberContext.close();
});
