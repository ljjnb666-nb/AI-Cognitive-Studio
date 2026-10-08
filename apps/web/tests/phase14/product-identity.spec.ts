import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";

const password = "ProductIdentityBrowser2026!";
const freshEmail = () => "identity-ui-" + randomUUID() + "@ai-cognitive-studio.test";
const candidate = (title: string) => ({
  kind: "epub",
  schemaVersion: "product-identity-candidate-v1",
  source: "EPUB_PACKAGE_METADATA",
  authority: "EVIDENCE_ONLY",
  title: { sourceField: "dc:title", value: title },
  language: { sourceField: "dc:language", value: "zh-CN" },
  identifier: { sourceField: "dc:identifier", value: "urn:isbn:978-0-306-40615-7", classification: "UNCLASSIFIED" },
});

async function signUp(page: Page) {
  const email = freshEmail();
  await page.goto("/sign-up");
  await page.locator('input[name="name"]').fill("Product Identity Acceptance");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  await page.getByRole("button", { name: "注册并进入 Studio" }).click();
  await expect(page).toHaveURL(/\/studio$/);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  expect(user.memberships).toHaveLength(1);
  return { userId: user.id, workspaceId: user.memberships[0]!.workspaceId };
}

async function epubFixture(userId: string, workspaceId: string, title: string, bindTitle?: string) {
  let editionId: string | undefined;
  if (bindTitle) {
    const work = await prisma.work.create({ data: { workspaceId, title: bindTitle } });
    const edition = await prisma.edition.create({ data: { workspaceId, workId: work.id, language: "en" } });
    editionId = edition.id;
  }
  const nonce = randomUUID();
  const blob = await prisma.sourceBlob.create({
    data: { workspaceId, sha256: nonce.replaceAll("-", ""), sizeBytes: 1, mediaType: "application/epub+zip", storageKey: "ui-identity/" + nonce },
  });
  const source = await prisma.source.create({
    data: { workspaceId, kind: "FILE", displayName: "测试书籍-" + nonce.slice(0, 8) + ".epub", editionId },
  });
  const document = await prisma.sourceDocument.create({
    data: {
      workspaceId, sourceId: source.id, sourceBlobId: blob.id, version: 1,
      sha256: blob.sha256, sizeBytes: 1, mediaType: "application/epub+zip", storageKey: blob.storageKey,
    },
  });
  const job = await prisma.job.create({
    data: { userId, workspaceId, type: "source.ingest", status: "SUCCEEDED", payload: {}, idempotencyKey: "ui-identity:" + nonce },
  });
  const run = await prisma.ingestionRun.create({
    data: { workspaceId, sourceDocumentId: document.id, jobId: job.id, parserVersion: "epub-parser-v2", normalizationVersion: "canonical-text-v1", status: "SUCCEEDED" },
  });
  const extraction = await prisma.documentExtraction.create({
    data: {
      workspaceId, sourceDocumentId: document.id, ingestionRunId: run.id,
      status: "SUCCEEDED", parserName: "builtin-epub", parserVersion: "epub-parser-v2",
      normalizationVersion: "canonical-text-v1", canonicalSchemaVersion: "canonical-book-v1",
      qualityStatus: "ACCEPTED", qualityMetadata: { warnings: [] },
      productIdentityCandidate: candidate(title),
    },
  });
  await prisma.currentDocumentExtraction.create({
    data: { workspaceId, sourceDocumentId: document.id, extractionId: extraction.id },
  });
  return { documentId: document.id, extractionId: extraction.id, sourceId: source.id, filename: source.displayName };
}

async function replaceExtraction(userId: string, workspaceId: string, documentId: string, title: string) {
  const job = await prisma.job.create({
    data: { userId, workspaceId, type: "source.ingest", payload: {}, idempotencyKey: "ui-identity-refresh:" + randomUUID() },
  });
  const run = await prisma.ingestionRun.create({
    data: { workspaceId, sourceDocumentId: documentId, jobId: job.id, parserVersion: "epub-parser-v2", normalizationVersion: "canonical-text-v1", status: "SUCCEEDED" },
  });
  const extraction = await prisma.documentExtraction.create({
    data: {
      workspaceId, sourceDocumentId: documentId, ingestionRunId: run.id,
      status: "SUCCEEDED", parserName: "builtin-epub", parserVersion: "epub-parser-v2",
      normalizationVersion: "canonical-text-v1", canonicalSchemaVersion: "canonical-book-v1",
      qualityStatus: "ACCEPTED", productIdentityCandidate: candidate(title),
    },
  });
  await prisma.currentDocumentExtraction.update({
    where: { sourceDocumentId_workspaceId: { sourceDocumentId: documentId, workspaceId } },
    data: { extractionId: extraction.id },
  });
}

const button = "核对并确认写入";
const confirmButton = "明确确认写入";
const detail = (id: string) => "/studio/library/" + id;

test("real OWNER/EDITOR/VIEWER: explicit EPUB confirmation, stale and conflicting updates", async ({ page }, info) => {
  test.skip(!["mobile-375", "desktop-1440"].includes(info.project.name), "Representative desktop/mobile; existing Phase 14 suites cover other layouts.");
  test.setTimeout(180_000);
  const { userId, workspaceId } = await signUp(page);

  // OWNER: read does not write, Escape cancels, only second confirmation commits.
  const owner = await epubFixture(userId, workspaceId, "产品身份 · OWNER");
  await page.goto(detail(owner.documentId));
  const panel = page.locator(".identity-panel");
  await expect(panel.getByText("产品身份 · OWNER")).toBeVisible();
  await expect(panel.getByText("未分类（仅为原始证据）")).toBeVisible();
  await expect(panel.getByText(owner.filename)).toBeVisible();
  await expect(page.getByRole("button", { name: button })).toBeEnabled();
  expect(await prisma.work.count({ where: { workspaceId } })).toBe(0);
  await page.getByRole("button", { name: button }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await prisma.work.count({ where: { workspaceId } })).toBe(0);
  await page.getByRole("button", { name: button }).click();
  await page.getByRole("button", { name: confirmButton }).click();
  await expect(panel).toContainText("书籍身份已写入");
  await expect(page.getByRole("button", { name: button })).toBeDisabled();
  const ownerSource = await prisma.source.findUniqueOrThrow({
    where: { id_workspaceId: { id: owner.sourceId, workspaceId } },
    include: { edition: { include: { work: true } } },
  });
  expect(ownerSource.edition?.work.title).toBe("产品身份 · OWNER");
  expect(ownerSource.edition?.isbn13).toBe("9780306406157");
  expect(await prisma.productIdentityPromotion.count({ where: { sourceDocumentId: owner.documentId } })).toBe(1);

  // VIEWER: read-only preview but direct POST remains forbidden.
  const viewer = await epubFixture(userId, workspaceId, "只读内容");
  await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } }, data: { role: "VIEWER" },
  });
  await page.goto(detail(viewer.documentId));
  await expect(panel.getByText("只读内容")).toBeVisible();
  await expect(panel.getByText("当前角色仅可查看，不具备写入权限。")).toBeVisible();
  await expect(page.getByRole("button", { name: button })).toBeDisabled();
  const denied = await page.request.post("/api/studio/identity/" + viewer.documentId, {
    data: { expectedExtractionId: viewer.extractionId }, headers: { Origin: "http://localhost:3014" },
  });
  expect(denied.status()).toBe(403);
  expect(await prisma.productIdentityPromotion.count({ where: { sourceDocumentId: viewer.documentId } })).toBe(0);

  // EDITOR: promotion is allowed by current server-side membership.
  const editor = await epubFixture(userId, workspaceId, "编辑者作品");
  await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } }, data: { role: "EDITOR" },
  });
  await page.goto(detail(editor.documentId));
  await expect(page.getByRole("button", { name: button })).toBeEnabled();
  await page.getByRole("button", { name: button }).click();
  await page.getByRole("button", { name: confirmButton }).click();
  await expect(panel).toContainText("书籍身份已写入");
  expect(await prisma.productIdentityPromotion.count({ where: { sourceDocumentId: editor.documentId } })).toBe(1);

  // STALE: change durable current extraction after preview, before the POST.
  const stale = await epubFixture(userId, workspaceId, "旧候选书名");
  await page.goto(detail(stale.documentId));
  await expect(page.getByRole("button", { name: button })).toBeEnabled();
  await page.getByRole("button", { name: button }).click();
  await replaceExtraction(userId, workspaceId, stale.documentId, "更新后的候选书名");
  await page.getByRole("button", { name: confirmButton }).click();
  await expect(panel.getByText("更新后的候选书名")).toBeVisible();
  expect(await prisma.productIdentityPromotion.count({ where: { sourceDocumentId: stale.documentId } })).toBe(0);
  expect((await prisma.source.findUniqueOrThrow({ where: { id_workspaceId: { id: stale.sourceId, workspaceId } } })).editionId).toBeNull();

  // CONFLICT: preserve manually owned product metadata and show conflict evidence.
  const conflict = await epubFixture(userId, workspaceId, "候选覆盖标题", "人工维护的书名");
  await page.goto(detail(conflict.documentId));
  await expect(page.getByRole("button", { name: button })).toBeEnabled();
  await page.getByRole("button", { name: button }).click();
  await page.getByRole("button", { name: confirmButton }).click();
  await expect(panel).toContainText("冲突");
  await expect(panel.getByText(/已有“人工维护的书名”/)).toBeVisible();
  const savedSource = await prisma.source.findUniqueOrThrow({
    where: { id_workspaceId: { id: conflict.sourceId, workspaceId } },
    include: { edition: { include: { work: true } } },
  });
  expect(savedSource.edition?.work.title).toBe("人工维护的书名");
  expect(savedSource.edition?.language).toBe("en");
  expect((await prisma.productIdentityPromotion.findUniqueOrThrow({ where: { extractionId: conflict.extractionId } })).status).toBe("CONFLICT");

  // Cross-workspace GET/POST must not reveal the other tenant's identity.
  const otherUser = await prisma.user.create({ data: { email: freshEmail() } });
  const otherWorkspace = await prisma.workspace.create({ data: { name: "identity other workspace" } });
  await prisma.workspaceMember.create({ data: { workspaceId: otherWorkspace.id, userId: otherUser.id, role: "OWNER" } });
  const privateDoc = await epubFixture(otherUser.id, otherWorkspace.id, "跨租户不可读取");
  expect((await page.request.get("/api/studio/identity/" + privateDoc.documentId)).status()).toBe(404);
  expect((await page.request.post("/api/studio/identity/" + privateDoc.documentId, {
    data: { expectedExtractionId: privateDoc.extractionId }, headers: { Origin: "http://localhost:3014" },
  })).status()).toBe(404);

  await page.screenshot({ path: info.outputPath("epub-identity-" + info.project.name + ".png"), fullPage: true });
});