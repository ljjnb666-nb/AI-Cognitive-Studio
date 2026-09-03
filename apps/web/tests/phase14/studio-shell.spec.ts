import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";

const password = "Phase14Password!";
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

async function capture(page: Page, name: string) {
  const directory = resolve(process.cwd(), "../../output/playwright");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, name), fullPage: true });
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
    await capture(page, name);
  }
});
