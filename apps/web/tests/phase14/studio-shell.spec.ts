import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";

const password = "Phase14Password!";
let phase14Email: string | undefined;
const destinations = [
  ["/studio", "首页"],
  ["/studio/library", "知识库"],
  ["/studio/cognitions", "我的认知"],
  ["/studio/thinking", "思考"],
  ["/studio/mastery", "理解"],
  ["/studio/podcasts", "播客"],
  ["/studio/videos", "短视频"],
  ["/studio/activity", "活动"],
  ["/studio/settings/account", "设置"],
] as const;

async function signUp(page: Page) {
  if (phase14Email) {
    await page.goto("/sign-in");
    await page.locator('input[name="email"]').fill(phase14Email);
    await page.locator('input[name="password"]').fill(password);
    const response = page.waitForResponse((item) =>
      item.url().endsWith("/api/auth/sign-in/email"),
    );
    await page.getByRole("button", { name: "登录并进入工作台" }).click();
    expect((await response).status()).toBe(200);
    await expect(page).toHaveURL(/\/studio$/);
    return phase14Email;
  }
  const email = `phase14-${Date.now()}@ai-cognitive-studio.test`;
  await page.goto("/sign-up");
  await page.locator('input[name="name"]').fill("Phase Fourteen Reader");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  const response = page.waitForResponse((item) =>
    item.url().endsWith("/api/auth/sign-up/email"),
  );
  await page.getByRole("button", { name: "注册并进入 Studio" }).click();
  expect((await response).status()).toBe(200);
  await expect(page).toHaveURL(/\/studio$/);
  phase14Email = email;
  return email;
}

async function currentCognition(workspaceId: string, userId: string) {
  const suffix = randomUUID();
  const source = await prisma.source.create({
    data: { workspaceId, kind: "FILE", displayName: "Phase 14 evidence.md" },
  });
  const blob = await prisma.sourceBlob.create({
    data: {
      workspaceId,
      sha256: suffix,
      sizeBytes: 1,
      mediaType: "text/markdown",
      storageKey: `phase14/${suffix}`,
    },
  });
  const document = await prisma.sourceDocument.create({
    data: {
      workspaceId,
      sourceId: source.id,
      sourceBlobId: blob.id,
      version: 1,
      sha256: suffix,
      sizeBytes: 1,
      mediaType: "text/markdown",
      storageKey: blob.storageKey,
    },
  });
  const ingestionJob = await prisma.job.create({
    data: {
      workspaceId,
      userId,
      type: "source.ingest",
      status: "SUCCEEDED",
      payload: {},
    },
  });
  const ingestion = await prisma.ingestionRun.create({
    data: {
      workspaceId,
      sourceDocumentId: document.id,
      jobId: ingestionJob.id,
      parserVersion: "phase14",
      normalizationVersion: "phase14",
      status: "SUCCEEDED",
    },
  });
  const extraction = await prisma.documentExtraction.create({
    data: {
      workspaceId,
      sourceDocumentId: document.id,
      ingestionRunId: ingestion.id,
      status: "SUCCEEDED",
      parserName: "phase14",
      parserVersion: "phase14",
      normalizationVersion: "phase14",
    },
  });
  const sourceText = "原文证据必须准确地回到读者可以核验的来源。";
  const block = await prisma.sourceBlock.create({
    data: {
      extractionId: extraction.id,
      ordinal: 0,
      kind: "PARAGRAPH",
      text: sourceText,
      contentHash: suffix,
    },
  });
  await prisma.currentDocumentExtraction.create({
    data: {
      workspaceId,
      sourceDocumentId: document.id,
      extractionId: extraction.id,
    },
  });
  const job = await prisma.job.create({
    data: {
      workspaceId,
      userId,
      type: "book.analysis",
      status: "SUCCEEDED",
      payload: {},
    },
  });
  const chunkSet = await prisma.chunkSet.create({
    data: {
      workspaceId,
      sourceDocumentId: document.id,
      extractionId: extraction.id,
      chunkingVersion: "phase14",
      configuration: {},
      configurationHash: suffix,
      status: "SUCCEEDED",
    },
  });
  const run = await prisma.bookAnalysisRun.create({
    data: {
      workspaceId,
      sourceDocumentId: document.id,
      extractionId: extraction.id,
      chunkSetId: chunkSet.id,
      jobId: job.id,
      pipelineVersion: "phase14",
      promptVersion: "phase14",
      provider: "fixture",
      model: "fixture",
      modelVersionKey: "fixture",
      idempotencyKey: `phase14:${suffix}`,
      analysisIdentityHash: `phase14:${suffix}`,
      status: "SUCCEEDED",
      analysisStage: "COMPLETED",
      completedAt: new Date(),
    },
  });
  const artifact = await prisma.analysisArtifact.create({
    data: {
      workspaceId,
      analysisRunId: run.id,
      chunkSetId: chunkSet.id,
      extractionId: extraction.id,
      scope: "BOOK",
      ordinal: 0,
      structuredOutput: {},
    },
  });
  const cognition = await prisma.bookMemoryItem.create({
    data: {
      workspaceId,
      sourceDocumentId: document.id,
      extractionId: extraction.id,
      analysisRunId: run.id,
      sourceArtifactId: artifact.id,
      type: "CLAIM",
      ordinal: 0,
      content: "可验证的认知从准确的原文开始。",
      contentHash: suffix,
      memoryKey: `${run.id}:0`,
    },
  });
  await prisma.bookMemoryEvidence.create({
    data: {
      workspaceId,
      analysisRunId: run.id,
      extractionId: extraction.id,
      memoryItemId: cognition.id,
      sourceBlockId: block.id,
      startOffset: 0,
      endOffset: sourceText.length,
    },
  });
  await prisma.currentBookIntelligence.create({
    data: {
      workspaceId,
      sourceDocumentId: document.id,
      extractionId: extraction.id,
      chunkSetId: chunkSet.id,
      analysisRunId: run.id,
    },
  });
  return { cognition };
}

async function sourceAwaitingAnalysis(workspaceId: string, userId: string) {
  const suffix = randomUUID();
  const source = await prisma.source.create({
    data: { workspaceId, kind: "FILE", displayName: "Phase 14 error fixture.md" },
  });
  const blob = await prisma.sourceBlob.create({
    data: {
      workspaceId,
      sha256: suffix,
      sizeBytes: 1,
      mediaType: "text/markdown",
      storageKey: `phase14-errors/${suffix}`,
    },
  });
  const document = await prisma.sourceDocument.create({
    data: {
      workspaceId,
      sourceId: source.id,
      sourceBlobId: blob.id,
      version: 1,
      sha256: suffix,
      sizeBytes: 1,
      mediaType: "text/markdown",
      storageKey: blob.storageKey,
    },
  });
  const job = await prisma.job.create({
    data: { workspaceId, userId, type: "source.ingest", status: "SUCCEEDED", payload: {} },
  });
  const ingestion = await prisma.ingestionRun.create({
    data: {
      workspaceId,
      sourceDocumentId: document.id,
      jobId: job.id,
      parserVersion: "phase14-errors",
      normalizationVersion: "phase14-errors",
      status: "SUCCEEDED",
    },
  });
  const extraction = await prisma.documentExtraction.create({
    data: {
      workspaceId,
      sourceDocumentId: document.id,
      ingestionRunId: ingestion.id,
      status: "SUCCEEDED",
      parserName: "phase14-errors",
      parserVersion: "phase14-errors",
      normalizationVersion: "phase14-errors",
    },
  });
  await prisma.currentDocumentExtraction.create({
    data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id },
  });
  return { document, extraction, suffix };
}

async function failedBookAnalysis(
  workspaceId: string,
  userId: string,
  errorCode: string,
) {
  const fixture = await sourceAwaitingAnalysis(workspaceId, userId);
  const job = await prisma.job.create({
    data: { workspaceId, userId, type: "book.analysis", status: "FAILED", payload: {} },
  });
  const chunkSet = await prisma.chunkSet.create({
    data: {
      workspaceId,
      sourceDocumentId: fixture.document.id,
      extractionId: fixture.extraction.id,
      chunkingVersion: "phase14-errors",
      configuration: {},
      configurationHash: fixture.suffix,
      status: "SUCCEEDED",
    },
  });
  await prisma.bookAnalysisRun.create({
    data: {
      workspaceId,
      sourceDocumentId: fixture.document.id,
      extractionId: fixture.extraction.id,
      chunkSetId: chunkSet.id,
      jobId: job.id,
      pipelineVersion: "phase14-errors",
      promptVersion: "phase14-errors",
      provider: "fixture",
      model: "fixture",
      modelVersionKey: "fixture",
      idempotencyKey: `phase14-errors:${fixture.suffix}`,
      analysisIdentityHash: `phase14-errors:${fixture.suffix}`,
      status: "FAILED",
      errorCode,
      completedAt: new Date(),
    },
  });
  return fixture.document.id;
}

async function capture(page: Page, name: string) {
  const directory = resolve(process.cwd(), "../../output/playwright");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, name), fullPage: true });
}

async function expectSearchIconInsideField(page: Page) {
  const wrapper = page.locator(".search-input-wrapper");
  const icon = wrapper.locator("svg");
  const field = wrapper.locator("input.input-control-search");
  await expect(field).toBeVisible();
  const [iconBox, fieldBox] = await Promise.all([icon.boundingBox(), field.boundingBox()]);
  expect(iconBox).not.toBeNull();
  expect(fieldBox).not.toBeNull();
  expect(iconBox!.x).toBeGreaterThanOrEqual(fieldBox!.x);
  expect(iconBox!.x + iconBox!.width).toBeLessThanOrEqual(fieldBox!.x + fieldBox!.width);
  expect(iconBox!.y).toBeGreaterThanOrEqual(fieldBox!.y);
  expect(iconBox!.y + iconBox!.height).toBeLessThanOrEqual(fieldBox!.y + fieldBox!.height);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function expectMobileContentClearance(page: Page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const geometry = await page.evaluate(() => {
    const main = document.querySelector("main");
    const group = document.querySelector(".mobile-group-nav");
    const bottom = document.querySelector(".mobile-nav");
    if (!main || !group || !bottom) return null;
    const bottomOfContent = Array.from(main.querySelectorAll("*"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return !element.closest(".mobile-nav, .mobile-group-nav") && style.display !== "none" && style.visibility !== "hidden" && box.height > 0;
      })
      .reduce((last, element) => Math.max(last, element.getBoundingClientRect().bottom), 0);
    return {
      contentBottom: bottomOfContent,
      bottomTop: bottom.getBoundingClientRect().top,
      groupPosition: window.getComputedStyle(group).position,
    };
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.contentBottom).toBeLessThanOrEqual(geometry!.bottomTop);
  expect(geometry!.groupPosition).not.toBe("fixed");
  const finalButton = page.locator("main button:not([disabled]):visible").last();
  if (await finalButton.count()) {
    await finalButton.scrollIntoViewIfNeeded();
    const actionability = await finalButton.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const target = document.elementFromPoint(centerX, centerY);
      return {
        inViewport:
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top >= 0 &&
          rect.bottom <= window.innerHeight,
        receivesPointerEvents: target === button || button.contains(target),
      };
    });
    expect(actionability.inViewport).toBe(true);
    expect(actionability.receivesPointerEvents).toBe(true);
  }
}

async function thinkingFixture(
  workspaceId: string,
  userId: string,
  memoryItemId: string,
) {
  const id = randomUUID(),
    first = randomUUID(),
    second = randomUUID();
  await prisma.thinkingSession.create({
    data: { id, workspaceId, userId, memoryItemId },
  });
  await prisma.thinkingSessionMessage.createMany({
    data: [
      {
        workspaceId,
        sessionId: id,
        role: "ASSISTANT",
        content: "先看看这条认知依赖什么证据？",
        ordinal: 0,
        replyToMessageId: `first:${id}`,
      },
      {
        workspaceId,
        sessionId: id,
        role: "USER",
        content: "它依赖可以回到原文核验的来源。",
        ordinal: 1,
        clientMessageId: first,
      },
      {
        workspaceId,
        sessionId: id,
        role: "ASSISTANT",
        content: "如果来源无法核验，结论会怎样？",
        ordinal: 2,
        replyToMessageId: first,
      },
      {
        workspaceId,
        sessionId: id,
        role: "USER",
        content: "那就应该保留不确定性，而不是延伸判断。",
        ordinal: 3,
        clientMessageId: second,
      },
      {
        workspaceId,
        sessionId: id,
        role: "ASSISTANT",
        content: "很好，再找一个反例来检验这个边界。",
        ordinal: 4,
        replyToMessageId: second,
      },
    ],
  });
  return id;
}

async function mediaFixture(workspaceId: string, userId: string) {
  const project = await prisma.podcastProject.create({
    data: { workspaceId, name: "Phase 14 阅读播客" },
  });
  const style = await prisma.podcastStyleProfile.create({
    data: { workspaceId, podcastProjectId: project.id, version: 1 },
  });
  await prisma.podcastEpisode.create({
    data: {
      workspaceId,
      podcastProjectId: project.id,
      styleProfileId: style.id,
      title: "证据与判断",
      language: "zh-CN",
      targetDurationMinutes: 12,
      status: "READY",
    },
  });
  const videoProject = await prisma.shortVideoProject.create({
    data: { workspaceId, name: "证据短视频", description: "确定性视觉夹具" },
  });
  const videoStyle = await prisma.shortVideoStyleProfile.create({
    data: { workspaceId, shortVideoProjectId: videoProject.id, version: 1 },
  });
  const videoJob = await prisma.job.create({
    data: {
      workspaceId,
      userId,
      type: "phase14-video-visual-job",
      status: "SUCCEEDED",
      payload: {},
    },
  });
  await prisma.shortVideoGenerationRun.create({
    data: {
      workspaceId,
      shortVideoProjectId: videoProject.id,
      styleProfileId: videoStyle.id,
      jobId: videoJob.id,
      provider: "fixture",
      model: "fixture",
      promptVersion: "phase14",
      pipelineVersion: "phase14",
      retrievalVersion: "phase14",
      scenePlannerVersion: "phase14",
      captionVersion: "phase14",
      audioVersion: "phase14",
      renderVersion: "phase14",
      generationIdentityHash: `phase14-video-${videoProject.id}`,
      idempotencyKey: `phase14-video-${videoProject.id}`,
      status: "SUCCEEDED",
      stage: "COMPLETED",
    },
  });
}

test("desktop navigation keeps one clear active destination", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-1024",
    "desktop acceptance only",
  );
  const email = await signUp(page);
  const primaryNavigation = page.locator(
    'nav[aria-label="主导航"] a[href="/studio/library"]',
  );
  for (
    let tabPresses = 0;
    tabPresses < 40 &&
    !(await primaryNavigation.evaluate(
      (element) => document.activeElement === element,
    ));
    tabPresses += 1
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(primaryNavigation).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/studio\/library$/);
  await expectSearchIconInsideField(page);
  for (const [path, label] of destinations) {
    await page.goto(path);
    await expect(
      page.locator('nav[aria-label="主导航"] a[aria-current="page"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('nav[aria-label="主导航"] a[aria-current="page"]'),
    ).toHaveAccessibleName(label);
  }
  await expect(page.getByRole("link", { name: "导入书籍" })).toBeVisible();
  const owner = await prisma.user.findUniqueOrThrow({
    where: { email },
    include: { memberships: true },
  });
  const fixture = await currentCognition(
    owner.memberships[0]!.workspaceId,
    owner.id,
  );
  await prisma.userCognitionState.create({
    data: {
      workspaceId: owner.memberships[0]!.workspaceId,
      userId: owner.id,
      memoryItemId: fixture.cognition.id,
    },
  });
  const sessionId = await thinkingFixture(
    owner.memberships[0]!.workspaceId,
    owner.id,
    fixture.cognition.id,
  );
  await mediaFixture(owner.memberships[0]!.workspaceId, owner.id);
  const attemptId = randomUUID();
  await prisma.teachBackAttempt.create({
    data: {
      id: attemptId,
      workspaceId: owner.memberships[0]!.workspaceId,
      userId: owner.id,
      memoryItemId: fixture.cognition.id,
      content: "确定性复述夹具。",
    },
  });
  for (const [path, label] of [
    [`/studio/cognitions/${fixture.cognition.id}`, "我的认知"],
    [`/studio/cognitions/${fixture.cognition.id}/teach-back`, "我的认知"],
    [`/studio/thinking/${sessionId}`, "思考"],
    ["/studio/mastery", "理解"],
    [`/studio/teach-back/${attemptId}`, "理解"],
    ["/studio/podcasts/new", "播客"],
    ["/studio/videos/new", "短视频"],
    ["/studio/settings/account", "设置"],
    ["/studio/settings/providers", "设置"],
  ]) {
    await page.goto(path);
    const current = page.locator(
      'nav[aria-label="主导航"] a[aria-current="page"]',
    );
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAccessibleName(label);
  }
  await page.goto(`/studio/cognitions/${fixture.cognition.id}`);
  const teachBack = page.getByRole("link", { name: "用自己的话讲一遍" });
  for (
    let tabPresses = 0;
    tabPresses < 80 &&
    !(await teachBack.evaluate(
      (element) => document.activeElement === element,
    ));
    tabPresses += 1
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(teachBack).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    new RegExp(`/studio/cognitions/${fixture.cognition.id}/teach-back$`),
  );
  await page.goto("/studio/cognitions");
  const review = page.getByRole("button", { name: "标记已复习" });
  await expect(review).toBeVisible();
  for (
    let tabPresses = 0;
    tabPresses < 80 &&
    !(await review.evaluate((element) => document.activeElement === element));
    tabPresses += 1
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(review).toBeFocused();
  const reviewResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .endsWith(`/api/studio/cognitions/${fixture.cognition.id}/review`),
  );
  await page.keyboard.press("Enter");
  await expect((await reviewResponse).status()).toBe(200);
  await expect(page.getByRole("button", { name: "已记录复习" })).toBeVisible();
  expect(
    await prisma.userCognitionReviewEvent.count({
      where: {
        workspaceId: owner.memberships[0]!.workspaceId,
        userId: owner.id,
        memoryItemId: fixture.cognition.id,
        kind: "MANUAL_REVIEW",
      },
    }),
  ).toBe(1);

  const file = {
    name: "evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("evidence"),
  };
  const sentinels = [
    "INTERNAL_TEST_SENTINEL",
    "DATABASE_PRIVATE_ERROR",
    "PROVIDER_INTERNAL_SECRET_ERROR",
  ];
  async function uploadWith(mode: "start" | "complete" | "transport", code: string) {
    await page.goto("/studio/library");
    await page.unrouteAll();
    await page.route("**/api/studio/upload", async (route) => {
      const payload = route.request().postDataJSON() as { sessionId?: string };
      if (mode === "complete" && payload.sessionId) {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: code }) });
        return;
      }
      if (mode === "start") {
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: code }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessionId: randomUUID(), upload: { url: "http://phase14.test/upload", headers: {} } }),
      });
    });
    if (mode === "complete" || mode === "transport") {
      await page.route("http://phase14.test/upload", async (route) => {
        await route.fulfill({ status: mode === "transport" ? 500 : 200 });
      });
    }
    await page.locator('input[type="file"]').setInputFiles(file);
  }
  await uploadWith("start", sentinels[0]!);
  await expect(page.getByText("上传没有完成，请稍后重试。")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(sentinels[0]!);
  await uploadWith("complete", sentinels[1]!);
  await expect(page.getByText("上传没有完成，请稍后重试。")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(sentinels[1]!);
  await uploadWith("transport", sentinels[2]!);
  await expect(page.getByText("文件没有上传完成，请重新选择后再试。")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(sentinels[2]!);

  await page.unrouteAll();
  const pendingSource = await sourceAwaitingAnalysis(
    owner.memberships[0]!.workspaceId,
    owner.id,
  );
  await page.route("**/api/studio/book-intelligence", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: sentinels[0] }),
    });
  });
  await page.goto(`/studio/library/${pendingSource.document.id}`);
  await expect(page.getByText("暂时无法完成这一步，请稍后重试。")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(sentinels[0]!);

  await page.unrouteAll();
  const terminalFailure = await failedBookAnalysis(
    owner.memberships[0]!.workspaceId,
    owner.id,
    sentinels[1]!,
  );
  await page.goto(`/studio/library/${terminalFailure}`);
  await expect(page.getByText("暂时无法完成这一步，请稍后重试。")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(sentinels[1]!);

  const providerFailure = await failedBookAnalysis(
    owner.memberships[0]!.workspaceId,
    owner.id,
    "AI_PROVIDER_CONFIGURATION_REQUIRED",
  );
  await page.goto(`/studio/library/${providerFailure}`);
  await expect(
    page.getByText("需要先配置 Provider，才能继续理解这本书。"),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "配置 AI Provider" })).toBeVisible();
});

test("mobile Studio pages have usable navigation and no horizontal overflow", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-375", "mobile acceptance only");
  const email = await signUp(page);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/studio/cognitions");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of [
    "/studio",
    "/studio/library",
    "/studio/cognitions",
    "/studio/thinking",
    "/studio/podcasts",
    "/studio/settings/account",
  ]) {
    await page.goto(path);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(
      page.getByRole("navigation", { name: "Mobile navigation" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Mobile navigation" })
        .locator('a[aria-current="page"]'),
    ).toHaveCount(1);
    if (path === "/studio/library") await expectSearchIconInsideField(page);
  }
  const owner = await prisma.user.findUniqueOrThrow({
    where: { email },
    include: { memberships: true },
  });
  const fixture = await currentCognition(
    owner.memberships[0]!.workspaceId,
    owner.id,
  );
  const sessionId = await thinkingFixture(
    owner.memberships[0]!.workspaceId,
    owner.id,
    fixture.cognition.id,
  );
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`/studio/thinking/${sessionId}`);
  await expect(page.locator("main")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const transcript = await page.locator(".thinking-transcript").boundingBox();
  const context = await page.locator(".thinking-context").boundingBox();
  expect(transcript?.width).toBeGreaterThan(480);
  expect(context?.width).toBeGreaterThan(480);
  await page.setViewportSize({ width: 375, height: 812 });
  for (const [path, group, child] of [
    ["/studio/cognitions", "认知", "我的认知"],
    [`/studio/thinking/${sessionId}`, "认知", "思考"],
    ["/studio/mastery", "认知", "理解"],
    ["/studio/podcasts", "表达", "播客"],
    ["/studio/videos", "表达", "短视频"],
    ["/studio/activity", "更多", "活动"],
    ["/studio/settings/account", "更多", "设置"],
  ]) {
    await page.goto(path);
    const bottom = page.getByRole("navigation", { name: "Mobile navigation" });
    await expect(bottom.locator('a[aria-current="page"]')).toHaveCount(1);
    await expect(bottom.locator('a[aria-current="page"]')).toHaveAccessibleName(group);
    const secondary = page.getByRole("navigation", { name: "移动端分组导航" });
    await expect(secondary).toBeVisible();
    await expect(secondary.locator('a[aria-current="page"]')).toHaveAccessibleName(child);
  }
  for (const path of [
    `/studio/cognitions/${fixture.cognition.id}`,
    `/studio/cognitions/${fixture.cognition.id}/teach-back`,
    `/studio/thinking/${sessionId}`,
    "/studio/mastery",
    "/studio/podcasts",
    "/studio/videos",
    "/studio/activity",
    "/studio/settings/providers",
  ]) {
    await page.goto(path);
    await expectMobileContentClearance(page);
  }
  for (const [path, name] of [
    ["/studio", "10-home-mobile.png"],
    ["/studio/cognitions", "11-cognitions-mobile.png"],
    [
      `/studio/cognitions/${fixture.cognition.id}`,
      "12-cognition-detail-mobile.png",
    ],
    [
      `/studio/cognitions/${fixture.cognition.id}/teach-back`,
      "13-teach-back-mobile.png",
    ],
    ["/studio", "14-mobile-navigation.png"],
    [`/studio/thinking/${sessionId}`, "15-thinking-detail-mobile.png"],
  ]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await capture(page, name);
  }
});

test("tablet project runs the configured 768px acceptance without mobile overlays", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "tablet-768", "tablet acceptance only");
  expect(testInfo.project.use.viewport).toEqual({ width: 768, height: 1024 });
  expect(testInfo.project.use.isMobile).not.toBe(true);
  const email = await signUp(page);
  const owner = await prisma.user.findUniqueOrThrow({
    where: { email },
    include: { memberships: true },
  });
  const fixture = await currentCognition(owner.memberships[0]!.workspaceId, owner.id);
  const sessionId = await thinkingFixture(
    owner.memberships[0]!.workspaceId,
    owner.id,
    fixture.cognition.id,
  );
  for (const path of [
    "/studio",
    "/studio/library",
    "/studio/cognitions",
    `/studio/cognitions/${fixture.cognition.id}`,
    "/studio/thinking",
    `/studio/thinking/${sessionId}`,
    "/studio/mastery",
    "/studio/podcasts",
    "/studio/videos",
    "/studio/settings/providers",
  ]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expect(page.locator(".mobile-nav")).toBeHidden();
    await expect(page.locator(".mobile-group-nav")).toBeHidden();
  }
  await page.goto(`/studio/thinking/${sessionId}`);
  const transcript = await page.locator(".thinking-transcript").boundingBox();
  const context = await page.locator(".thinking-context").boundingBox();
  expect(transcript?.width).toBeGreaterThan(480);
  expect(context?.width).toBeGreaterThan(480);
  expect(Math.abs((transcript?.x ?? 0) - (context?.x ?? 0))).toBeLessThan(2);
});


test("captures the final Studio experience evidence", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-1440", "desktop evidence only");
  const email = await signUp(page);
  const owner = await prisma.user.findUniqueOrThrow({
    where: { email },
    include: { memberships: true },
  });
  const fixture = await currentCognition(
    owner.memberships[0]!.workspaceId,
    owner.id,
  );
  const sessionId = await thinkingFixture(
    owner.memberships[0]!.workspaceId,
    owner.id,
    fixture.cognition.id,
  );
  const workspaceId = owner.memberships[0]!.workspaceId;
  await prisma.userCognitionState.create({
    data: { workspaceId, userId: owner.id, memoryItemId: fixture.cognition.id },
  });
  const reviewAttempt = await prisma.teachBackAttempt.create({
    data: {
      id: randomUUID(),
      workspaceId,
      userId: owner.id,
      memoryItemId: fixture.cognition.id,
      content: "可验证的结论需要回到原文证据。",
      status: "ASSESSED",
      assessedAt: new Date(),
    },
  });
  await prisma.teachBackAssessment.create({
    data: {
      workspaceId,
      attemptId: reviewAttempt.id,
      masteryState: "DEVELOPING",
      rubric: [],
      feedback: "还可以继续用反例检验这条认知。",
    },
  });
  await prisma.userCognitionReviewState.create({
    data: {
      workspaceId,
      userId: owner.id,
      memoryItemId: fixture.cognition.id,
      reviewCount: 1,
      lastReviewedAt: new Date(Date.now() - 86_400_000),
      nextReviewAt: new Date(Date.now() - 1_000),
      lastMasteryState: "DEVELOPING",
      lastMasteryAssessedAt: new Date(),
    },
  });
  await mediaFixture(workspaceId, owner.id);
  const desktop = testInfo.project.name === "desktop-1440";
  const shots = desktop
    ? [
        ["/studio", "01-home-desktop.png"],
        ["/studio/library", "02-library-desktop.png"],
        ["/studio/cognitions", "03-cognitions-desktop.png"],
        [
          `/studio/cognitions/${fixture.cognition.id}`,
          "04-cognition-detail-desktop.png",
        ],
        ["/studio/thinking", "05-thinking-desktop.png"],
        ["/studio/mastery", "06-mastery-desktop.png"],
        ["/studio/podcasts", "07-podcasts-desktop.png"],
        ["/studio/videos", "08-videos-desktop.png"],
        ["/studio/settings/account", "09-settings-desktop.png"],
        [`/studio/thinking/${sessionId}`, "16-thinking-detail-desktop.png"],
        ["/studio/library", "17-library-populated-desktop.png"],
        ["/studio/settings/providers", "18-provider-settings-desktop.png"],
      ]
    : [
        ["/studio", "10-home-mobile.png"],
        ["/studio/cognitions", "11-cognitions-mobile.png"],
        [
          `/studio/cognitions/${fixture.cognition.id}`,
          "12-cognition-detail-mobile.png",
        ],
        [
          `/studio/cognitions/${fixture.cognition.id}/teach-back`,
          "13-teach-back-mobile.png",
        ],
        ["/studio", "14-mobile-navigation.png"],
      ];
  for (const [path, name] of shots) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
    if (name === "01-home-desktop.png") {
      await expect(page.getByText("短视频动态")).toBeVisible();
    }
    if (name === "02-library-desktop.png" || name === "17-library-populated-desktop.png") {
      await expectSearchIconInsideField(page);
    }
    if (name === "07-podcasts-desktop.png") {
      await expect(page.getByRole("heading", { name: "证据与判断" })).toBeVisible();
    }
    if (name === "08-videos-desktop.png") {
      await expect(page.getByRole("heading", { name: "证据短视频" })).toBeVisible();
    }
    if (name === "18-provider-settings-desktop.png") {
      await expect(page.getByRole("navigation", { name: "设置导航" }).locator('a[aria-current="page"]')).toHaveAccessibleName("Provider");
      await expect(page.locator('nav[aria-label="主导航"] a[aria-current="page"]')).toHaveAccessibleName("设置");
      await expect(page.getByText("未完成", { exact: false }).first()).toBeVisible();
      await expect(page.locator("body")).not.toContainText("sk-");
    }
    await capture(page, name);
  }
});
