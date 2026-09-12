import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";

const password = "Phase10Password!";

async function signUp(page: import("@playwright/test").Page, email: string) {
  await page.goto("/sign-up");
  await page.locator('input[name="name"]').fill("Phase Ten Reader");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  await page.getByRole("button", { name: "注册并进入 Studio" }).click();
  await expect(page).toHaveURL(/\/studio$/);
}

async function currentCognition(workspaceId: string, userId: string) {
  const suffix = randomUUID();
  const source = await prisma.source.create({ data: { workspaceId, kind: "FILE", displayName: "真实认知来源.md" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: `phase10/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: blob.storageKey } });
  const ingestionJob = await prisma.job.create({ data: { workspaceId, userId, type: "source.ingest", status: "SUCCEEDED", payload: {} } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId, sourceDocumentId: document.id, jobId: ingestionJob.id, parserVersion: "phase10", normalizationVersion: "phase10", status: "SUCCEEDED" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "phase10", parserVersion: "phase10", normalizationVersion: "phase10" } });
  const sourceText = "原文证据必须准确地回到读者可以核验的来源。";
  const block = await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal: 0, kind: "PARAGRAPH", text: sourceText, contentHash: suffix } });
  await prisma.currentDocumentExtraction.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id } });
  const job = await prisma.job.create({ data: { workspaceId, userId, type: "book.analysis", status: "SUCCEEDED", payload: {} } });
  const chunkSet = await prisma.chunkSet.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "phase10", configuration: {}, configurationHash: suffix, status: "SUCCEEDED" } });
  const run = await prisma.bookAnalysisRun.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunkSet.id, jobId: job.id, pipelineVersion: "phase10", promptVersion: "phase10", provider: "fixture", model: "fixture", modelVersionKey: "fixture", idempotencyKey: `phase10:${suffix}`, analysisIdentityHash: `phase10:${suffix}`, status: "SUCCEEDED", analysisStage: "COMPLETED", completedAt: new Date() } });
  const artifact = await prisma.analysisArtifact.create({ data: { workspaceId, analysisRunId: run.id, chunkSetId: chunkSet.id, extractionId: extraction.id, scope: "BOOK", ordinal: 0, structuredOutput: {} } });
  const evidence = await prisma.bookMemoryItem.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, analysisRunId: run.id, sourceArtifactId: artifact.id, type: "CLAIM", ordinal: 0, content: "可验证的认知从准确的原文开始。", contentHash: suffix, memoryKey: `${run.id}:0` } });
  const noEvidence = await prisma.bookMemoryItem.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, analysisRunId: run.id, sourceArtifactId: artifact.id, type: "SUMMARY", ordinal: 1, content: "这是一条没有直接证据的书籍层认知。", contentHash: `${suffix}:summary`, memoryKey: `${run.id}:1` } });
  await prisma.bookMemoryEvidence.create({ data: { workspaceId, analysisRunId: run.id, extractionId: extraction.id, memoryItemId: evidence.id, sourceBlockId: block.id, startOffset: 0, endOffset: sourceText.length } });
  await prisma.currentBookIntelligence.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunkSet.id, analysisRunId: run.id } });
  return { document, evidence, noEvidence, sourceText };
}

test("real Better Auth user browses versioned cognition, exact evidence, state, navigation, and private 404", async ({ page, browser }) => {
  const email = `phase10-owner-${Date.now()}@ai-cognitive-studio.test`;
  await signUp(page, email);
  const owner = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const workspaceId = owner.memberships[0]!.workspaceId;
  const fixture = await currentCognition(workspaceId, owner.id);

  await page.goto("/studio/cognitions?view=all");
  await expect(page.getByRole("heading", { name: "全部认知" })).toBeVisible();
  await expect(page.getByText(fixture.evidence.content, { exact: true })).toBeVisible();
  await page.getByText(fixture.evidence.content, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/studio/cognitions/${fixture.evidence.id}$`));
  await expect(page.getByText(`“${fixture.sourceText}”`, { exact: true })).toBeVisible();
  await expect(page.getByRole("article").getByText("关键主张", { exact: true })).toBeVisible();
  await expect(page.getByText("有来源依据", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "收藏认知" }).click();
  await expect(page.getByRole("button", { name: "已收藏" })).toBeVisible();
  expect(await prisma.userCognitionState.findUnique({ where: { workspaceId_userId_memoryItemId: { workspaceId, userId: owner.id, memoryItemId: fixture.evidence.id } } })).toMatchObject({ state: "SAVED" });
  await page.goto("/studio/cognitions");
  await expect(page.locator("h1", { hasText: "我的认知" })).toBeVisible();
  await expect(page.getByRole("link", { name: fixture.evidence.content, exact: true }).first()).toBeVisible();

  await page.goto(`/studio/library/${fixture.document.id}`);
  await page.getByRole("link", { name: "查看认知详情" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/studio/cognitions/${fixture.evidence.id}$`));
  await page.goto(`/studio/cognitions/${fixture.noEvidence.id}`);
  await expect(page.getByText("暂无可验证来源证据", { exact: true })).toBeVisible();
  await expect(page.getByText("未附来源证据", { exact: true })).toBeVisible();

  const foreignContext = await browser.newContext();
  const foreignPage = await foreignContext.newPage();
  await signUp(foreignPage, `phase10-foreign-${Date.now()}@ai-cognitive-studio.test`);
  const forbidden = await foreignPage.request.get(`/studio/cognitions/${fixture.evidence.id}`);
  expect(forbidden.status()).toBe(404);
  expect(await forbidden.text()).not.toContain(fixture.evidence.content);
  await foreignContext.close();
});
