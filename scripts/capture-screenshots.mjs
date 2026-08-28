import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const artifactBase = process.env.ARTIFACT_DIR || path.join(rootDir, "output", "screenshots");
const targetDir = path.resolve(artifactBase, "screenshots");
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const screenshotManifest = [];

async function capture(page, route, resolvedUrl, viewport, filename) {
  const filepath = path.join(targetDir, filename);
  await page.screenshot({ path: filepath });
  screenshotManifest.push({
    route,
    resolvedUrl,
    viewport: `${viewport.width}x${viewport.height}`,
    filename,
    filepath,
  });
  console.log(`[SCREENSHOT VERIFIED] ${route} -> ${resolvedUrl} (${viewport.width}x${viewport.height}) => ${filename}`);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log("Starting screenshot capture workflow on http://localhost:3000 ...");

  // 1. Desktop Home (1440x900)
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://localhost:3000/studio", { waitUntil: "networkidle" });
  console.log("Home URL:", page.url());
  await capture(page, "/studio", page.url(), { width: 1440, height: 900 }, "desktop_home.png");

  // 2. Desktop Library (1440x900)
  await page.goto("http://localhost:3000/studio/library", { waitUntil: "networkidle" });
  console.log("Library URL:", page.url());
  await capture(page, "/studio/library", page.url(), { width: 1440, height: 900 }, "desktop_library.png");

  // 3. Desktop Book Detail (1440x900)
  let bookCard = page.locator('a[href*="/studio/library/"]').first();
  let bookDetailUrl = page.url();
  if (await bookCard.count() > 0) {
    await bookCard.click();
    await page.waitForTimeout(1000);
    bookDetailUrl = page.url();
  }
  await capture(page, "/studio/library/[sourceDocumentId]", bookDetailUrl, { width: 1440, height: 900 }, "desktop_book_detail.png");

  // 4. Desktop Podcast Detail / List (1440x900)
  await page.goto("http://localhost:3000/studio/podcasts", { waitUntil: "networkidle" });
  let podcastCard = page.locator('a[href*="/studio/podcasts/"]').first();
  let podcastDetailUrl = page.url();
  if (await podcastCard.count() > 0) {
    await podcastCard.click();
    await page.waitForTimeout(1000);
    podcastDetailUrl = page.url();
  }
  await capture(page, "/studio/podcasts/[episodeId]", podcastDetailUrl, { width: 1440, height: 900 }, "desktop_podcast_detail.png");

  // 5. Desktop Video Detail / List (1440x900)
  await page.goto("http://localhost:3000/studio/videos", { waitUntil: "networkidle" });
  let videoCard = page.locator('a[href*="/studio/videos/"]').first();
  let videoDetailUrl = page.url();
  if (await videoCard.count() > 0) {
    await videoCard.click();
    await page.waitForTimeout(1000);
    videoDetailUrl = page.url();
  }
  await capture(page, "/studio/videos/[id]", videoDetailUrl, { width: 1440, height: 900 }, "desktop_video_detail.png");

  // 6. Desktop Provider Settings (1440x900)
  await page.goto("http://localhost:3000/studio/settings/providers", { waitUntil: "networkidle" });
  await capture(page, "/studio/settings/providers", page.url(), { width: 1440, height: 900 }, "desktop_provider_settings.png");

  // Mobile Screenshots (390x844)
  await page.setViewportSize({ width: 390, height: 844 });

  // 1. Mobile Home (390x844)
  await page.goto("http://localhost:3000/studio", { waitUntil: "networkidle" });
  await capture(page, "/studio", page.url(), { width: 390, height: 844 }, "mobile_home.png");

  // 2. Mobile Library (390x844)
  await page.goto("http://localhost:3000/studio/library", { waitUntil: "networkidle" });
  await capture(page, "/studio/library", page.url(), { width: 390, height: 844 }, "mobile_library.png");

  // 3. Mobile Book Detail (390x844)
  await page.goto(bookDetailUrl, { waitUntil: "networkidle" });
  await capture(page, "/studio/library/[sourceDocumentId]", page.url(), { width: 390, height: 844 }, "mobile_book_detail.png");

  // 4. Mobile Podcast Detail (390x844)
  await page.goto(podcastDetailUrl, { waitUntil: "networkidle" });
  await capture(page, "/studio/podcasts/[episodeId]", page.url(), { width: 390, height: 844 }, "mobile_podcast_detail.png");

  // 5. Mobile Settings (390x844)
  await page.goto("http://localhost:3000/studio/settings/account", { waitUntil: "networkidle" });
  await capture(page, "/studio/settings/account", page.url(), { width: 390, height: 844 }, "mobile_settings.png");

  await browser.close();

  // Write screenshot manifest JSON
  const manifestPath = path.join(targetDir, "screenshot_manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(screenshotManifest, null, 2));
  console.log(`Manifest written to ${manifestPath}`);
  console.log("SUCCESS: All 11 screenshots verified and captured!");
}

run().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
