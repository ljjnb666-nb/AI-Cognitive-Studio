import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";

const password = "Phase14Password!";
const destinations = [
  ["/studio", "首页"], ["/studio/library", "知识库"], ["/studio/cognitions", "我的认知"], ["/studio/thinking", "思考"], ["/studio/mastery", "理解"], ["/studio/podcasts", "播客"], ["/studio/videos", "短视频"], ["/studio/activity", "活动"], ["/studio/settings/account", "设置"],
] as const;

async function signUp(page: Page) {
  const email = `phase14-${Date.now()}@ai-cognitive-studio.test`;
  await page.goto("/sign-up");
  await page.locator('input[name="name"]').fill("Phase Fourteen Reader");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  const response = page.waitForResponse((item) => item.url().endsWith("/api/auth/sign-up/email"));
  await page.getByRole("button", { name: "注册并进入 Studio" }).click();
  expect((await response).status()).toBe(200);
  await expect(page).toHaveURL(/\/studio$/);
  return email;
}

async function currentCognition(workspaceId: string, userId: string) {
  const suffix = randomUUID();
  const source = await prisma.source.create({ data: { workspaceId, kind: "FILE", displayName: "Phase 14 evidence.md" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: `phase14/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: blob.storageKey } });
  const ingestionJob = await prisma.job.create({ data: { workspaceId, userId, type: "source.ingest", status: "SUCCEEDED", payload: {} } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId, sourceDocumentId: document.id, jobId: ingestionJob.id, parserVersion: "phase14", normalizationVersion: "phase14", status: "SUCCEEDED" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "phase14", parserVersion: "phase14", normalizationVersion: "phase14" } });
  const sourceText = "原文证据必须准确地回到读者可以核验的来源。";
  const block = await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal: 0, kind: "PARAGRAPH", text: sourceText, contentHash: suffix } });
  await prisma.currentDocumentExtraction.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id } });
  const job = await prisma.job.create({ data: { workspaceId, userId, type: "book.analysis", status: "SUCCEEDED", payload: {} } });
  const chunkSet = await prisma.chunkSet.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "phase14", configuration: {}, configurationHash: suffix, status: "SUCCEEDED" } });
  const run = await prisma.bookAnalysisRun.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunkSet.id, jobId: job.id, pipelineVersion: "phase14", promptVersion: "phase14", provider: "fixture", model: "fixture", modelVersionKey: "fixture", idempotencyKey: `phase14:${suffix}`, analysisIdentityHash: `phase14:${suffix}`, status: "SUCCEEDED", analysisStage: "COMPLETED", completedAt: new Date() } });
  const artifact = await prisma.analysisArtifact.create({ data: { workspaceId, analysisRunId: run.id, chunkSetId: chunkSet.id, extractionId: extraction.id, scope: "BOOK", ordinal: 0, structuredOutput: {} } });
  const cognition = await prisma.bookMemoryItem.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, analysisRunId: run.id, sourceArtifactId: artifact.id, type: "CLAIM", ordinal: 0, content: "可验证的认知从准确的原文开始。", contentHash: suffix, memoryKey: `${run.id}:0` } });
  await prisma.bookMemoryEvidence.create({ data: { workspaceId, analysisRunId: run.id, extractionId: extraction.id, memoryItemId: cognition.id, sourceBlockId: block.id, startOffset: 0, endOffset: sourceText.length } });
  await prisma.currentBookIntelligence.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunkSet.id, analysisRunId: run.id } });
  return { cognition };
}

async function capture(page: Page, name: string) {
  const directory = resolve(process.cwd(), "../../output/playwright");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, name), fullPage: true });
}

async function thinkingFixture(workspaceId: string, userId: string, memoryItemId: string) {
  const id = randomUUID(), first = randomUUID(), second = randomUUID();
  await prisma.thinkingSession.create({ data: { id, workspaceId, userId, memoryItemId } });
  await prisma.thinkingSessionMessage.createMany({ data: [
    { workspaceId, sessionId: id, role: "ASSISTANT", content: "先看看这条认知依赖什么证据？", ordinal: 0, replyToMessageId: `first:${id}` },
    { workspaceId, sessionId: id, role: "USER", content: "它依赖可以回到原文核验的来源。", ordinal: 1, clientMessageId: first },
    { workspaceId, sessionId: id, role: "ASSISTANT", content: "如果来源无法核验，结论会怎样？", ordinal: 2, replyToMessageId: first },
    { workspaceId, sessionId: id, role: "USER", content: "那就应该保留不确定性，而不是延伸判断。", ordinal: 3, clientMessageId: second },
    { workspaceId, sessionId: id, role: "ASSISTANT", content: "很好，再找一个反例来检验这个边界。", ordinal: 4, replyToMessageId: second },
  ] });
  return id;
}

test("desktop navigation keeps one clear active destination", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1024", "desktop acceptance only");
  await signUp(page);
  for (const [path, label] of destinations) {
    await page.goto(path);
    await expect(page.locator('nav[aria-label="主导航"] a[aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('nav[aria-label="主导航"] a[aria-current="page"]')).toHaveAccessibleName(label);
  }
  await expect(page.getByRole("link", { name: "导入书籍" })).toBeVisible();
});

test("mobile Studio pages have usable navigation and no horizontal overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-375", "mobile acceptance only");
  const email = await signUp(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/studio/cognitions");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ["/studio", "/studio/library", "/studio/cognitions", "/studio/thinking", "/studio/podcasts", "/studio/settings/account"]) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Mobile navigation" }).locator('a[aria-current="page"]')).toHaveCount(1);
  }
  const owner = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const fixture = await currentCognition(owner.memberships[0]!.workspaceId, owner.id);
  const sessionId = await thinkingFixture(owner.memberships[0]!.workspaceId, owner.id, fixture.cognition.id);
  for (const [path, name] of [["/studio", "10-home-mobile.png"], ["/studio/cognitions", "11-cognitions-mobile.png"], [`/studio/cognitions/${fixture.cognition.id}`, "12-cognition-detail-mobile.png"], [`/studio/cognitions/${fixture.cognition.id}/teach-back`, "13-teach-back-mobile.png"], ["/studio", "14-mobile-navigation.png"], [`/studio/thinking/${sessionId}`, "15-thinking-detail-mobile.png"]]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await capture(page, name);
  }
});

test("captures the final Studio experience evidence", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1440", "desktop evidence only");
  const email = await signUp(page);
  const owner = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const fixture = await currentCognition(owner.memberships[0]!.workspaceId, owner.id);
  const sessionId = await thinkingFixture(owner.memberships[0]!.workspaceId, owner.id, fixture.cognition.id);
  const desktop = testInfo.project.name === "desktop-1440";
  const shots = desktop
    ? [["/studio", "01-home-desktop.png"], ["/studio/library", "02-library-desktop.png"], ["/studio/cognitions", "03-cognitions-desktop.png"], [`/studio/cognitions/${fixture.cognition.id}`, "04-cognition-detail-desktop.png"], ["/studio/thinking", "05-thinking-desktop.png"], ["/studio/mastery", "06-mastery-desktop.png"], ["/studio/podcasts", "07-podcasts-desktop.png"], ["/studio/videos", "08-videos-desktop.png"], ["/studio/settings/account", "09-settings-desktop.png"], [`/studio/thinking/${sessionId}`, "16-thinking-detail-desktop.png"], ["/studio/library", "17-library-populated-desktop.png"], ["/studio/settings/providers", "18-provider-settings-desktop.png"]]
    : [["/studio", "10-home-mobile.png"], ["/studio/cognitions", "11-cognitions-mobile.png"], [`/studio/cognitions/${fixture.cognition.id}`, "12-cognition-detail-mobile.png"], [`/studio/cognitions/${fixture.cognition.id}/teach-back`, "13-teach-back-mobile.png"], ["/studio", "14-mobile-navigation.png"]];
  for (const [path, name] of shots) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await capture(page, name);
  }
});
