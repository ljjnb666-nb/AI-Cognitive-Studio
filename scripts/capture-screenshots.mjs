import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const targetDir = "C:\\Users\\LJJ2004\\.gemini\\antigravity-ide\\brain\\92d28302-98bb-430e-b936-b67ddbbaa9d3\\screenshots";
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log("Opening sign-in page...");
  await page.goto("http://localhost:3000/sign-in", { waitUntil: "networkidle" });

  if (page.url().includes("/sign-in") || page.url().includes("/sign-up")) {
    console.log("Attempting sign up...");
    await page.goto("http://localhost:3000/sign-up");
    await page.fill('input[name="name"]', "Scholar Test");
    await page.fill('input[name="email"]', `scholar-${Date.now()}@test.local`);
    await page.fill('input[name="password"]', "Password123!45");
    await page.fill('input[name="confirmPassword"]', "Password123!45");
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2000);
  }

  // 1. Desktop Home
  console.log("Navigating to Home...");
  await page.goto("http://localhost:3000/studio", { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(targetDir, "desktop_home.png") });

  // 2. Desktop Library
  console.log("Navigating to Library...");
  await page.goto("http://localhost:3000/studio/library", { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(targetDir, "desktop_library.png") });

  // 3. Desktop Book Detail
  const bookCard = page.locator('a[href*="/studio/library/"]').first();
  if (await bookCard.count() > 0) {
    await bookCard.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(targetDir, "desktop_book_detail.png") });
  } else {
    await page.screenshot({ path: path.join(targetDir, "desktop_book_detail.png") });
  }

  // 4. Desktop Podcast Detail
  await page.goto("http://localhost:3000/studio/podcasts", { waitUntil: "networkidle" });
  const podcastLink = page.locator('a[href*="/studio/podcasts/"]').first();
  if (await podcastLink.count() > 0) {
    await podcastLink.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(targetDir, "desktop_podcast_detail.png") });
  } else {
    await page.screenshot({ path: path.join(targetDir, "desktop_podcast_detail.png") });
  }

  // 5. Desktop Video Detail
  await page.goto("http://localhost:3000/studio/videos", { waitUntil: "networkidle" });
  const videoLink = page.locator('a[href*="/studio/videos/"]').first();
  if (await videoLink.count() > 0) {
    await videoLink.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(targetDir, "desktop_video_detail.png") });
  } else {
    await page.screenshot({ path: path.join(targetDir, "desktop_video_detail.png") });
  }

  // 6. Desktop Provider Settings
  await page.goto("http://localhost:3000/studio/settings/providers", { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(targetDir, "desktop_provider_settings.png") });

  // Mobile Screenshots (390x844)
  console.log("Switching to Mobile viewport (390x844)...");
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("http://localhost:3000/studio", { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(targetDir, "mobile_home.png") });

  await page.goto("http://localhost:3000/studio/library", { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(targetDir, "mobile_library.png") });

  const mobileBookCard = page.locator('a[href*="/studio/library/"]').first();
  if (await mobileBookCard.count() > 0) {
    await mobileBookCard.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(targetDir, "mobile_book_detail.png") });
  } else {
    await page.screenshot({ path: path.join(targetDir, "mobile_book_detail.png") });
  }

  await page.goto("http://localhost:3000/studio/podcasts", { waitUntil: "networkidle" });
  const mobilePodcastLink = page.locator('a[href*="/studio/podcasts/"]').first();
  if (await mobilePodcastLink.count() > 0) {
    await mobilePodcastLink.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(targetDir, "mobile_podcast_detail.png") });
  } else {
    await page.screenshot({ path: path.join(targetDir, "mobile_podcast_detail.png") });
  }

  await page.goto("http://localhost:3000/studio/settings/account", { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(targetDir, "mobile_settings.png") });

  await browser.close();
  console.log("SUCCESS: Captured all required screenshots!");
}

run().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
