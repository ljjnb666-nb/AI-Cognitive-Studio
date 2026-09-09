import { expect, test } from "@playwright/test";
import { createRedisConnection } from "@ai-cognitive/shared/server";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const harnessToken = process.env.WEB_TEST_HARNESS_TOKEN!;
const heartbeatKey = "ai-cognitive:worker:processing";
const recoverySource = join(process.cwd(), "..", "..", "output", "phase18-1", "worker-down-source-id.txt");

test("worker-down upload becomes a recoverable degraded processing state without mocked requests", async ({ page }) => {
  test.skip(process.env.PHASE18_1_WORKER_DOWN_ONLY !== "true", "only runs before the Worker runtime starts");
  const redis = createRedisConnection(process.env.REDIS_URL!);
  await redis.del(heartbeatKey);
  await page.context().addCookies([{ name: "acs_phase6_harness", value: harnessToken, url: "http://localhost:3001", httpOnly: true, sameSite: "Lax" }]);
  try {
    await page.goto("/studio/library");
    await page.waitForLoadState("networkidle");
    await page.locator('input[type="file"]').setInputFiles({ name: "worker-down.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n") });
    await expect(page).toHaveURL(/\/studio\/library\//, { timeout: 30_000 });
    const sourceDocumentId = new URL(page.url()).pathname.split("/").pop();
    if (!sourceDocumentId) throw new Error("PHASE18_1_SOURCE_ID_MISSING");
    await mkdir(join(recoverySource, ".."), { recursive: true });
    await writeFile(recoverySource, sourceDocumentId, "utf8");
    await expect(page.getByText("正在等待解析")).toBeVisible();
    await page.waitForTimeout(1_200);
    await page.reload();
    await expect(page.getByText("后台处理服务暂时没有响应。你的文件已经保存，可以稍后重试。")).toBeVisible();
    await expect(page.getByRole("button", { name: "重试解析" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新检查状态" })).toBeVisible();
  } finally { await redis.quit(); }
});

test("worker recovery processes the same degraded upload and renders grounded intelligence", async ({ page, browser }, testInfo) => {
  test.skip(process.env.PHASE18_1_WORKER_DOWN_ONLY === "true", "runs after the Worker runtime starts");
  const sourceDocumentId = (await readFile(recoverySource, "utf8")).trim();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("favicon")) errors.push(message.text()); });
  await page.context().addCookies([{ name: "acs_phase6_harness", value: harnessToken, url: "http://localhost:3001", httpOnly: true, sameSite: "Lax" }]);
  await page.goto(`/studio/library/${sourceDocumentId}`);
  await page.getByRole("button", { name: "重新检查状态" }).click();
  await expect(page.getByRole("link", { name: "生成播客" })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("暂无可展示的原文证据。")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("worker-recovery-desktop.png"), fullPage: true });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try { await mobile.addCookies([{ name: "acs_phase6_harness", value: harnessToken, url: "http://localhost:3001", httpOnly: true, sameSite: "Lax" }]); const mobilePage = await mobile.newPage(); await mobilePage.goto(`/studio/library/${sourceDocumentId}`); await expect(mobilePage.getByRole("link", { name: "生成播客" })).toBeVisible({ timeout: 30_000 }); await mobilePage.screenshot({ path: testInfo.outputPath("worker-recovery-mobile.png"), fullPage: true }); }
  finally { await mobile.close(); }
  expect(errors).toEqual([]);
});
