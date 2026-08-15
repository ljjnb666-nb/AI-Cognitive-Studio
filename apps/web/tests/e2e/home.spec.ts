import { expect, test } from "@playwright/test";

test("requires authentication for Studio", async ({ page }) => {
  await page.goto("/studio");

  await expect(page).toHaveURL(/\/sign-in\?callbackUrl=%2Fstudio$/);
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
  expect((await page.request.post("/api/studio/upload", { data: { filename: "unauthenticated.md", mediaType: "text/markdown", sizeBytes: 1 } })).status()).toBe(403);
});

test("serves the health contract over HTTP", async ({ request }) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  await expect(response.json()).resolves.toEqual({ status: "ok", service: "web" });
});
