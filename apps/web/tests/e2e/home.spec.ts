import { expect, test } from "@playwright/test";

test("opens the workspace-scoped product shell", async ({ page }) => {
  await page.goto("/studio");

  await expect(page.getByRole("heading", { name: "让一本书，成为可聆听、可观看的理解" })).toBeVisible();
  await expect(page.getByRole("link", { name: "知识库" })).toBeVisible();
  await expect(page.getByRole("link", { name: "上传一本书" })).toBeVisible();
});

test("serves the health contract over HTTP", async ({ request }) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  await expect(response.json()).resolves.toEqual({ status: "ok", service: "web" });
});
