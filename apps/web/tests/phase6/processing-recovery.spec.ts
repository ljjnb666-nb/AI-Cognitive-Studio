import { expect, test } from "@playwright/test";
import { createRedisConnection } from "@ai-cognitive/shared/server";

const harnessToken = process.env.WEB_TEST_HARNESS_TOKEN!;
const heartbeatKey = "ai-cognitive:worker:processing";

test("worker-down upload becomes a recoverable degraded processing state without mocked requests", async ({ page }) => {
  const redis = createRedisConnection(process.env.REDIS_URL!);
  await redis.del(heartbeatKey);
  await page.context().addCookies([{ name: "acs_phase6_harness", value: harnessToken, url: "http://localhost:3001", httpOnly: true, sameSite: "Lax" }]);
  try {
    await page.goto("/studio/library");
    await page.waitForLoadState("networkidle");
    await page.locator('input[type="file"]').setInputFiles({ name: "worker-down.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n") });
    await expect(page).toHaveURL(/\/studio\/library\//, { timeout: 30_000 });
    await expect(page.getByText("正在等待解析")).toBeVisible();
    await page.waitForTimeout(1_200);
    await page.reload();
    await expect(page.getByText("后台处理服务暂时没有响应。你的文件已经保存，可以稍后重试。")).toBeVisible();
    await expect(page.getByRole("button", { name: "重试解析" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新检查状态" })).toBeVisible();
  } finally { await redis.quit(); }
});
