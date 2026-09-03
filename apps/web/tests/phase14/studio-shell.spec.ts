import { expect, test, type Page } from "@playwright/test";

const password = "Phase14Password!";
const destinations = [
  ["/studio", "首页"], ["/studio/library", "知识库"], ["/studio/cognitions", "我的认知"], ["/studio/thinking", "思考"], ["/studio/mastery", "理解"], ["/studio/podcasts", "播客"], ["/studio/videos", "短视频"], ["/studio/activity", "活动"], ["/studio/settings/account", "设置"],
] as const;

async function signUp(page: Page) {
  const email = `phase14-${Date.now()}@ai-cognitive-studio.test`;
  await page.goto("/sign-up");
  await page.locator('input[name="name"]').fill("Phase Fourteen Reader");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  const response = page.waitForResponse((item) => item.url().endsWith("/api/auth/sign-up/email"));
  await page.getByRole("button", { name: "注册并进入 Studio" }).click();
  expect((await response).status()).toBe(200);
  await expect(page).toHaveURL(/\/studio$/);
}

test("desktop navigation keeps one clear active destination", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop acceptance only");
  await signUp(page);
  for (const [path, label] of destinations) {
    await page.goto(path);
    await expect(page.locator('nav[aria-label="主导航"] a[aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('nav[aria-label="主导航"] a[aria-current="page"]')).toHaveAccessibleName(label);
  }
  await expect(page.getByRole("link", { name: "导入书籍" })).toBeVisible();
});

test("mobile Studio pages have usable navigation and no horizontal overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile acceptance only");
  await signUp(page);
  for (const path of ["/studio", "/studio/library", "/studio/cognitions", "/studio/thinking", "/studio/podcasts", "/studio/settings/account"]) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('nav[aria-label="移动端主导航"]')).toBeVisible();
    await expect(page.locator('nav[aria-label="移动端主导航"] a[aria-current="page"]')).toHaveCount(1);
  }
});
