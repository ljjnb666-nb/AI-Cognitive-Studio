import { expect, test } from "@playwright/test";

test("shows the Phase 0 foundation status", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "AI Cognitive Studio" })).toBeVisible();
  await expect(page.getByText("Phase 0 Foundation")).toBeVisible();
  await expect(page.getByText("System status: Ready")).toBeVisible();
});

test("serves the health contract over HTTP", async ({ request }) => {
  const response = await request.get("/api/health");

  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/json");
  await expect(response.json()).resolves.toEqual({ status: "ok", service: "web" });
});
