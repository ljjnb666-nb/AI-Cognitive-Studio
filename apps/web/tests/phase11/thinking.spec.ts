import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";

const password = "Phase11Password!";

async function signUp(page: import("@playwright/test").Page, email: string) {
  await page.goto("/sign-up");
  await page.locator('input[name="name"]').fill("Phase Eleven Reader");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  await page.getByRole("button", { name: "注册并进入 Studio" }).click();
  await expect(page).toHaveURL(/\/studio$/);
}

async function currentCognition(workspaceId: string, userId: string) {
  const suffix = randomUUID();
  const source = await prisma.source.create({ data: { workspaceId, kind: "FILE", displayName: "思考会话来源.md" } });
  const blob = await prisma.sourceBlob.create({ data: { workspaceId, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: `phase11/${suffix}` } });
  const document = await prisma.sourceDocument.create({ data: { workspaceId, sourceId: source.id, sourceBlobId: blob.id, version: 1, sha256: suffix, sizeBytes: 1, mediaType: "text/markdown", storageKey: blob.storageKey } });
  const ingestionJob = await prisma.job.create({ data: { workspaceId, userId, type: "source.ingest", status: "SUCCEEDED", payload: {} } });
  const ingestion = await prisma.ingestionRun.create({ data: { workspaceId, sourceDocumentId: document.id, jobId: ingestionJob.id, parserVersion: "phase11", normalizationVersion: "phase11", status: "SUCCEEDED" } });
  const extraction = await prisma.documentExtraction.create({ data: { workspaceId, sourceDocumentId: document.id, ingestionRunId: ingestion.id, status: "SUCCEEDED", parserName: "phase11", parserVersion: "phase11", normalizationVersion: "phase11" } });
  const sourceText = "原文证据必须准确地回到读者可以核验的来源。";
  const block = await prisma.sourceBlock.create({ data: { extractionId: extraction.id, ordinal: 0, kind: "PARAGRAPH", text: sourceText, contentHash: suffix } });
  await prisma.currentDocumentExtraction.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id } });
  const job = await prisma.job.create({ data: { workspaceId, userId, type: "book.analysis", status: "SUCCEEDED", payload: {} } });
  const chunkSet = await prisma.chunkSet.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkingVersion: "phase11", configuration: {}, configurationHash: suffix, status: "SUCCEEDED" } });
  const run = await prisma.bookAnalysisRun.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunkSet.id, jobId: job.id, pipelineVersion: "phase11", promptVersion: "phase11", provider: "fixture", model: "fixture", modelVersionKey: "fixture", idempotencyKey: `phase11:${suffix}`, analysisIdentityHash: `phase11:${suffix}`, status: "SUCCEEDED", analysisStage: "COMPLETED", completedAt: new Date() } });
  const artifact = await prisma.analysisArtifact.create({ data: { workspaceId, analysisRunId: run.id, chunkSetId: chunkSet.id, extractionId: extraction.id, scope: "BOOK", ordinal: 0, structuredOutput: {} } });
  const cognition = await prisma.bookMemoryItem.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, analysisRunId: run.id, sourceArtifactId: artifact.id, type: "CLAIM", ordinal: 0, content: "可验证的认知从准确的原文开始。", contentHash: suffix, memoryKey: `${run.id}:0` } });
  await prisma.bookMemoryEvidence.create({ data: { workspaceId, analysisRunId: run.id, extractionId: extraction.id, memoryItemId: cognition.id, sourceBlockId: block.id, startOffset: 0, endOffset: sourceText.length } });
  await prisma.currentBookIntelligence.create({ data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id, chunkSetId: chunkSet.id, analysisRunId: run.id } });
  return { cognition, sourceText };
}

async function configureThinkingRoute(page: import("@playwright/test").Page) {
  const created = await page.evaluate(async () => {
    const response = await fetch("/api/studio/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "CREATE_CONNECTION", providerKey: "phase11-fixture", protocol: "TEST", displayName: "Phase 11 Fixture", endpoint: "https://example.com", configuration: {} }) });
    return response.json() as Promise<{ connections: Array<{ id: string }> }>;
  });
  const connectionId = created.connections[0]!.id;
  for (const payload of [{ action: "SET_CREDENTIAL", connectionId, secret: "phase11-browser-fixture-secret" }, { action: "SET_ROUTE", connectionId, routeSlot: "THINKING_SESSION", modelId: "phase11-thinking", configuration: {} }]) {
    const status = await page.evaluate(async value => (await fetch("/api/studio/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) })).status, payload);
    expect(status).toBe(200);
  }
}

test("real Better Auth session creates, persists, completes, and protects a grounded thinking session", async ({ page, browser }) => {
  const email = `phase11-owner-${Date.now()}@ai-cognitive-studio.test`;
  await signUp(page, email);
  const owner = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const workspaceId = owner.memberships[0]!.workspaceId;
  const fixture = await currentCognition(workspaceId, owner.id);

  await page.goto(`/studio/cognitions/${fixture.cognition.id}`);
  await expect(page.getByRole("button", { name: "开始思考" })).toBeVisible();
  await page.getByRole("button", { name: "开始思考" }).click();
  await expect(page.getByText("思考会话尚未就绪，请先配置 Provider。", { exact: false })).toBeVisible();
  await configureThinkingRoute(page);
  const creationIds: string[] = [];
  let creationAttempt = 0;
  await page.route("**/api/studio/thinking-sessions", async route => {
    if (route.request().method() !== "POST") return route.continue();
    creationIds.push((route.request().postDataJSON() as { sessionId: string }).sessionId);
    if (creationAttempt++ === 0) {
      await route.fetch();
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "RETRYABLE" }) });
      return;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "开始思考" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "开始思考" }).click();
  await expect(page).toHaveURL(/\/studio\/thinking\//);
  expect(creationIds).toHaveLength(2);
  expect(creationIds[1]).toBe(creationIds[0]);
  await expect(page.getByText("你愿意用哪一条证据来检验这个判断？", { exact: true })).toBeVisible();
  await expect(page.getByText(`“${fixture.sourceText}”`, { exact: true })).toBeVisible();
  const sessionId = page.url().split("/").at(-1)!;
  expect(await prisma.thinkingSession.count({ where: { id: sessionId } })).toBe(1);
  const messageIds: string[] = [];
  let messageAttempt = 0;
  await page.route(`**/api/studio/thinking-sessions/${sessionId}/messages`, async route => {
    if (route.request().method() !== "POST") return route.continue();
    messageIds.push((route.request().postDataJSON() as { clientMessageId: string }).clientMessageId);
    if (messageAttempt++ === 0) {
      await route.fetch();
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "RETRYABLE" }) });
      return;
    }
    if (messageAttempt === 3) {
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: sessionId, pending: true }) });
      return;
    }
    await route.continue();
  });
  await page.getByLabel("你的回应").fill("我会先核验原文证据。");
  await page.getByRole("button", { name: "提交回应" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("你的回应")).toHaveValue("我会先核验原文证据。");
  await page.getByRole("button", { name: "提交回应" }).click();
  await expect(page.getByText("我会先核验原文证据。", { exact: true })).toBeVisible();
  await expect.poll(() => prisma.thinkingSessionMessage.count({ where: { sessionId, role: "USER" } })).toBe(1);
  await expect.poll(() => prisma.thinkingSessionMessage.count({ where: { sessionId, role: "ASSISTANT" } })).toBe(2);
  await expect(page.getByLabel("你的回应")).toHaveValue("");
  expect(messageIds[1]).toBe(messageIds[0]);

  await page.getByLabel("你的回应").fill("这一回应仍在生成。");
  await page.getByRole("button", { name: "提交回应" }).click();
  await expect(page.getByText("回应仍在生成中，请使用相同内容重试。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("你的回应")).toHaveValue("这一回应仍在生成。");
  expect(await prisma.thinkingSessionMessage.count({ where: { sessionId, role: "USER" } })).toBe(1);
  await page.getByRole("button", { name: "提交回应" }).click();
  await expect.poll(() => prisma.thinkingSessionMessage.count({ where: { sessionId, role: "ASSISTANT" } })).toBe(3);
  await expect(page.getByLabel("你的回应")).toHaveValue("");
  expect(messageIds[3]).toBe(messageIds[2]);
  expect(messageIds[2]).not.toBe(messageIds[0]);

  await page.getByLabel("你的回应").fill("这是新的逻辑回应。");
  await page.getByRole("button", { name: "提交回应" }).click();
  await expect.poll(() => prisma.thinkingSessionMessage.count({ where: { sessionId, role: "ASSISTANT" } })).toBe(4);
  expect(messageIds[4]).not.toBe(messageIds[2]);
  await page.reload();
  await expect(page.getByText("我会先核验原文证据。", { exact: true })).toBeVisible();
  const sessionUrl = page.url();
  await page.goto("/studio/thinking");
  await expect(page.getByRole("heading", { name: "思考" })).toBeVisible();
  await expect(page.getByText(fixture.cognition.content, { exact: true })).toBeVisible();
  await page.goto(sessionUrl);
  await page.getByRole("button", { name: "结束思考" }).click();
  await expect(page.getByText("这次思考已结束。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "提交回应" })).toBeDisabled();

  const sameWorkspaceContext = await browser.newContext();
  const sameWorkspacePage = await sameWorkspaceContext.newPage();
  const memberEmail = `phase11-member-${Date.now()}@ai-cognitive-studio.test`;
  await signUp(sameWorkspacePage, memberEmail);
  const member = await prisma.user.findUniqueOrThrow({ where: { email: memberEmail } });
  await prisma.workspaceMember.create({ data: { workspaceId, userId: member.id, role: "VIEWER" } });
  await prisma.user.update({ where: { id: member.id }, data: { defaultWorkspaceId: workspaceId } });
  const sameWorkspace = await sameWorkspacePage.request.get(sessionUrl);
  expect(sameWorkspace.status()).toBe(404);
  expect(await sameWorkspace.text()).not.toContain("我会先核验原文证据。");
  await sameWorkspaceContext.close();

  const foreignContext = await browser.newContext();
  const foreignPage = await foreignContext.newPage();
  await signUp(foreignPage, `phase11-foreign-${Date.now()}@ai-cognitive-studio.test`);
  const foreign = await foreignPage.request.get(sessionUrl);
  expect(foreign.status()).toBe(404);
  expect(await foreign.text()).not.toContain(fixture.cognition.content);
  await foreignContext.close();
});
