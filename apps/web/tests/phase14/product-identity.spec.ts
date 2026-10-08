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
  // An unpromoted file displays its original name, not advisory EPUB dc:title.
  await expect(page.locator(".book-detail-layout h1")).toHaveText(owner.filename);
  await expect(panel.locator(".identity-data-block").first().getByText("产品身份 · OWNER")).toBeVisible();
  await expect(panel.getByText("未分类（仅为原始证据）")).toBeVisible();
  await expect(panel.locator(".identity-file").first()).toContainText(owner.filename);
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
  // Read-after-commit updates the detail title and library card through the
  // authoritative Source -> Edition -> Work relation, preserving original name.
  await expect(page.locator(".book-detail-layout h1")).toHaveText("产品身份 · OWNER");
  await page.goto("/studio/library");
  const ownerCard = page.locator('a[href="/studio/library/' + owner.documentId + '"]');
  await expect(ownerCard.locator("h3")).toHaveText("产品身份 · OWNER");
  await expect(ownerCard).toContainText(owner.filename);
  await expect(ownerCard).toContainText("文件版本 v1");

  // VIEWER: read-only preview but direct POST remains forbidden.
  const viewer = await epubFixture(userId, workspaceId, "只读内容");
  await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } }, data: { role: "VIEWER" },
  });
  await page.goto(detail(viewer.documentId));
  await expect(panel.locator(".identity-data-block").first().getByText("只读内容")).toBeVisible();
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
  await expect(panel.locator(".identity-data-block").first().getByText("更新后的候选书名")).toBeVisible();
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

test("04C-4C4B browser: OWNER and EDITOR correct authoritative identity, VIEWER and outsiders cannot", async ({ page }, info) => {
  test.skip(!["mobile-375", "desktop-1440"].includes(info.project.name), "Representative Phase 14 browser layouts.");
  test.setTimeout(240_000);
  const { userId, workspaceId } = await signUp(page);
  const owner = await epubFixture(userId, workspaceId, "仅解析候选标题", "已保存正式书名");
  await page.goto(detail(owner.documentId));
  const panel = page.locator(".identity-panel");
  await expect(panel.getByRole("button", { name: "编辑正式书籍信息" })).toBeEnabled();
  await panel.getByRole("button", { name: "编辑正式书籍信息" }).click();
  const form = panel.getByRole("form", { name: "人工修正正式信息" });
  await expect(form.getByRole("button", { name: "核对修改内容" })).toBeDisabled();
  await form.getByLabel("正式书名").fill("出版社核实的正式书名");
  await form.getByLabel("ISBN-10").fill("0306406152");
  await form.getByLabel(/修正原因/).fill("核对纸质书版权页后纠正");
  await form.getByRole("button", { name: "核对修改内容" }).click();
  const dialog = page.getByRole("dialog", { name: "确认保存这些人工修正？" });
  await expect(dialog).toContainText("已保存正式书名");
  await expect(dialog).toContainText("出版社核实的正式书名");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(await prisma.productIdentityManualEdit.count({ where: { sourceDocumentId: owner.documentId } })).toBe(0);
  await form.getByRole("button", { name: "核对修改内容" }).click();
  await dialog.getByRole("button", { name: "确认保存人工修正" }).click();
  await expect(panel.locator(".identity-status").first()).toContainText("人工修正已保存");
  await expect(page.locator(".book-detail-layout h1")).toHaveText("出版社核实的正式书名");
  await expect(panel.getByText("修正原因：核对纸质书版权页后纠正")).toBeVisible();
  const audit = await prisma.productIdentityManualEdit.findFirstOrThrow({
    where: { sourceDocumentId: owner.documentId },
  });
  expect(audit.actorUserId).toBe(userId);
  expect(audit.reason).toBe("核对纸质书版权页后纠正");
  expect(audit.changes).toEqual({
    "work.title": { before: "已保存正式书名", after: "出版社核实的正式书名" },
    "edition.isbn10": { before: null, after: "0306406152" },
  });
  expect(await prisma.productIdentityPromotion.count({ where: { sourceDocumentId: owner.documentId } })).toBe(0);
  const extraction = await prisma.documentExtraction.findUniqueOrThrow({ where: { id: owner.extractionId } });
  expect((extraction.productIdentityCandidate as { title: { value: string } }).title.value).toBe("仅解析候选标题");
  await page.goto("/studio/library");
  await expect(page.locator('a[href="/studio/library/' + owner.documentId + '"] h3')).toHaveText("出版社核实的正式书名");

  await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } }, data: { role: "VIEWER" },
  });
  await page.goto(detail(owner.documentId));
  await expect(panel.getByText(/当前角色为只读权限/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "编辑正式书籍信息" })).toHaveCount(0);
  const getResponse = await page.request.get("/api/studio/identity/" + owner.documentId);
  expect(getResponse.status()).toBe(200);
  const snapshot = await getResponse.json();
  const payload = {
    expectedExtractionId: snapshot.currentExtractionId,
    expectedWorkId: snapshot.product.workId,
    expectedEditionId: snapshot.product.editionId,
    expectedWorkUpdatedAt: snapshot.product.workUpdatedAt,
    expectedEditionUpdatedAt: snapshot.product.editionUpdatedAt,
    expectedValues: {
      title: snapshot.product.title, language: snapshot.product.language,
      isbn10: snapshot.product.isbn10, isbn13: snapshot.product.isbn13,
    },
    values: { title: "非法更改" }, reason: "尝试越权更改",
  };
  const endpoint = "/api/studio/identity/" + owner.documentId + "/corrections";
  const denied = await page.request.post(endpoint, {
    data: payload, headers: { Origin: "http://localhost:3014" },
  });
  expect(denied.status()).toBe(403);
  const originDenied = await page.request.post(endpoint, {
    data: payload, headers: { Origin: "https://evil.example.com" },
  });
  expect(originDenied.status()).toBe(403);
  const browser = page.context().browser();
  if (!browser) throw new Error("Browser missing in live acceptance");
  const anonymous = await browser.newContext();
  try {
    const response = await anonymous.request.post("http://localhost:3014" + endpoint, {
      data: payload, headers: { Origin: "http://localhost:3014" },
    });
    expect(response.status()).toBe(401);
  } finally { await anonymous.close(); }
  const otherUser = await prisma.user.create({ data: { email: freshEmail() } });
  const otherWorkspace = await prisma.workspace.create({ data: { name: "identity correction private" } });
  await prisma.workspaceMember.create({ data: { workspaceId: otherWorkspace.id, userId: otherUser.id, role: "OWNER" } });
  const privateDocument = await epubFixture(otherUser.id, otherWorkspace.id, "private", "private official");
  expect((await page.request.get("/api/studio/identity/" + privateDocument.documentId)).status()).toBe(404);
  expect((await page.request.post("/api/studio/identity/" + privateDocument.documentId + "/corrections", {
    data: payload, headers: { Origin: "http://localhost:3014" },
  })).status()).toBe(404);

  await prisma.workspaceMember.update({
    where: { workspaceId_userId: { workspaceId, userId } }, data: { role: "EDITOR" },
  });
  const editor = await epubFixture(userId, workspaceId, "编辑者候选", "编辑者正式书名");
  await page.goto(detail(editor.documentId));
  await panel.getByRole("button", { name: "编辑正式书籍信息" }).click();
  const editorForm = panel.getByRole("form", { name: "人工修正正式信息" });
  await editorForm.getByLabel("语言", { exact: true }).fill("fr");
  await editorForm.getByLabel(/修正原因/).fill("编辑者核对了原书语言");
  await editorForm.getByRole("button", { name: "核对修改内容" }).click();
  await page.getByRole("dialog", { name: "确认保存这些人工修正？" }).getByRole("button", { name: "确认保存人工修正" }).click();
  await expect(panel.locator(".identity-status").first()).toContainText("人工修正已保存");
  expect(await prisma.productIdentityManualEdit.count({ where: { sourceDocumentId: editor.documentId } })).toBe(1);
  const editorAudit = await prisma.productIdentityManualEdit.findFirstOrThrow({ where: { sourceDocumentId: editor.documentId } });
  expect(editorAudit.changes).toEqual({ "edition.language": { before: "en", after: "fr" } });

  const invalid = await epubFixture(userId, workspaceId, "非法 ISBN 候选", "合法正式书名");
  await page.goto(detail(invalid.documentId));
  await panel.getByRole("button", { name: "编辑正式书籍信息" }).click();
  const invalidForm = panel.getByRole("form", { name: "人工修正正式信息" });
  await invalidForm.getByLabel("ISBN-13").fill("1234567890123");
  await invalidForm.getByLabel(/修正原因/).fill("测试非法校验位必须拒绝");
  await invalidForm.getByRole("button", { name: "核对修改内容" }).click();
  await page.getByRole("dialog", { name: "确认保存这些人工修正？" }).getByRole("button", { name: "确认保存人工修正" }).click();
  await expect(panel.locator(".identity-status").first()).toContainText("输入不符合服务端校验");
  expect(await prisma.productIdentityManualEdit.count({ where: { sourceDocumentId: invalid.documentId } })).toBe(0);
});

test("04C-4C4B browser: concurrent tab, stale extraction, superseded file and transport uncertainty", async ({ page }, info) => {
  test.skip(!["mobile-375", "desktop-1440"].includes(info.project.name), "Representative Phase 14 browser layouts.");
  test.setTimeout(240_000);
  const { userId, workspaceId } = await signUp(page);
  const fixture = await epubFixture(userId, workspaceId, "EPUB 元数据候选", "并发前正式书名");
  const second = await page.context().newPage();
  try {
    await page.goto(detail(fixture.documentId));
    await second.goto(detail(fixture.documentId));
    const panel = page.locator(".identity-panel");
    const otherPanel = second.locator(".identity-panel");
    await panel.getByRole("button", { name: "编辑正式书籍信息" }).click();
    await otherPanel.getByRole("button", { name: "编辑正式书籍信息" }).click();
    const firstForm = panel.getByRole("form", { name: "人工修正正式信息" });
    const secondForm = otherPanel.getByRole("form", { name: "人工修正正式信息" });
    await firstForm.getByLabel("正式书名").fill("标签一已提交");
    await firstForm.getByLabel(/修正原因/).fill("标签一合法修正");
    await secondForm.getByLabel("正式书名").fill("标签二不能覆盖");
    await secondForm.getByLabel(/修正原因/).fill("标签二陈旧快照");
    await firstForm.getByRole("button", { name: "核对修改内容" }).click();
    await page.getByRole("dialog", { name: "确认保存这些人工修正？" }).getByRole("button", { name: "确认保存人工修正" }).click();
    await expect(panel.locator(".identity-status").first()).toContainText("人工修正已保存");
    await secondForm.getByRole("button", { name: "核对修改内容" }).click();
    await second.getByRole("dialog", { name: "确认保存这些人工修正？" }).getByRole("button", { name: "确认保存人工修正" }).click();
    await expect(otherPanel.locator(".identity-status").first()).toContainText("不会覆盖");
    await expect(otherPanel).toContainText("标签一已提交");
    expect(await prisma.productIdentityManualEdit.count({ where: { sourceDocumentId: fixture.documentId } })).toBe(1);
    await expect(page.locator(".book-detail-layout h1")).toHaveText("标签一已提交");
  } finally { await second.close(); }

  const stale = await epubFixture(userId, workspaceId, "旧解析候选", "待修正书名");
  await page.goto(detail(stale.documentId));
  const panel = page.locator(".identity-panel");
  await panel.getByRole("button", { name: "编辑正式书籍信息" }).click();
  let form = panel.getByRole("form", { name: "人工修正正式信息" });
  await form.getByLabel("正式书名").fill("不应保存的陈旧版本");
  await form.getByLabel(/修正原因/).fill("演练解析版本并发变化");
  await form.getByRole("button", { name: "核对修改内容" }).click();
  await replaceExtraction(userId, workspaceId, stale.documentId, "新解析证据");
  await page.getByRole("dialog", { name: "确认保存这些人工修正？" }).getByRole("button", { name: "确认保存人工修正" }).click();
  await expect(panel.locator(".identity-status").first()).toContainText("当前解析已更新");
  expect(await prisma.productIdentityManualEdit.count({ where: { sourceDocumentId: stale.documentId } })).toBe(0);

  const superseded = await epubFixture(userId, workspaceId, "旧文件候选", "旧文件正式书名");
  await page.goto(detail(superseded.documentId));
  await panel.getByRole("button", { name: "编辑正式书籍信息" }).click();
  form = panel.getByRole("form", { name: "人工修正正式信息" });
  await form.getByLabel("正式书名").fill("过期文件不得提交");
  await form.getByLabel(/修正原因/).fill("新版本替代旧文件");
  await form.getByRole("button", { name: "核对修改内容" }).click();
  const original = await prisma.sourceDocument.findUniqueOrThrow({ where: { id: superseded.documentId } });
  await prisma.sourceDocument.create({ data: {
    workspaceId, sourceId: superseded.sourceId, sourceBlobId: original.sourceBlobId,
    version: 2, sha256: original.sha256, sizeBytes: original.sizeBytes,
    mediaType: original.mediaType, storageKey: original.storageKey,
  } });
  await page.getByRole("dialog", { name: "确认保存这些人工修正？" }).getByRole("button", { name: "确认保存人工修正" }).click();
  await expect(panel.locator(".identity-status").first()).toContainText("新版本");
  expect(await prisma.productIdentityManualEdit.count({ where: { sourceDocumentId: superseded.documentId } })).toBe(0);

  const network = await epubFixture(userId, workspaceId, "网络异常候选", "网络异常原书名");
  await page.goto(detail(network.documentId));
  await panel.getByRole("button", { name: "编辑正式书籍信息" }).click();
  form = panel.getByRole("form", { name: "人工修正正式信息" });
  await form.getByLabel("正式书名").fill("不得虚报成功");
  await form.getByLabel(/修正原因/).fill("演练提交时网络断开");
  await form.getByRole("button", { name: "核对修改内容" }).click();
  await page.route("**/corrections", (route) => route.abort("failed"));
  await page.getByRole("dialog", { name: "确认保存这些人工修正？" }).getByRole("button", { name: "确认保存人工修正" }).click();
  await expect(panel.locator(".identity-status").first()).toContainText("网络异常");
  await expect(page.locator(".book-detail-layout h1")).toHaveText("网络异常原书名");
  expect(await prisma.productIdentityManualEdit.count({ where: { sourceDocumentId: network.documentId } })).toBe(0);
  await page.unroute("**/corrections");
  await page.screenshot({ path: info.outputPath("identity-manual-04c4b-" + info.project.name + ".png"), fullPage: true });
});
