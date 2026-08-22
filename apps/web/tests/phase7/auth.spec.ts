import { createHash } from "node:crypto";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";
import { createS3CompatibleStorageProvider } from "@ai-cognitive/storage";

const password = "Phase7Password!1";
let nextTestIp = 10;

function captureErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("favicon")) errors.push(message.text()); });
  return errors;
}

async function signUp(page: Page, name: string, email: string) {
  await page.goto("/sign-up");
  await page.locator('input[name="name"]').fill(name);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/studio$/);
}

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/studio$/);
}

async function signedUp(browser: Browser, name: string, email: string) {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${nextTestIp++}` } });
  const page = await context.newPage();
  await signUp(page, name, email);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  expect(user.memberships).toHaveLength(1);
  return { context, page, user, workspaceId: user.memberships[0]!.workspaceId };
}

async function uploadBook(page: Page, filename: string) {
  await page.goto("/studio/library");
  const contents = `# ${filename}\n\n${"Tenant-scoped evidence must never be exposed to another authenticated workspace. ".repeat(300)}`;
  await page.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: "text/markdown", buffer: Buffer.from(contents) });
  await expect(page).toHaveURL(/\/studio\/library\/[^/]+$/, { timeout: 30_000 });
  const sourceDocumentId = page.url().split("/").pop()!;
  await expect.poll(async () => (await prisma.currentBookIntelligence.findFirst({ where: { sourceDocumentId } }))?.id, { timeout: 90_000 }).toBeTruthy();
  return sourceDocumentId;
}

async function assertDurableGatewayPrincipal(input: { sourceDocumentId: string; userId: string; workspaceId: string }) {
  const run = await prisma.bookAnalysisRun.findFirstOrThrow({ where: { sourceDocumentId: input.sourceDocumentId, status: "SUCCEEDED", analysisStage: "COMPLETED" }, include: { job: true }, orderBy: { createdAt: "desc" } });
  expect(run.workspaceId).toBe(input.workspaceId);
  expect(run.job).toMatchObject({ userId: input.userId, workspaceId: input.workspaceId });
  expect(await prisma.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId } } })).not.toBeNull();
  const invocation = await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: input.workspaceId, idempotencyKey: `book-analysis-embeddings:${run.id}` } });
  const result = await prisma.providerEmbeddingResult.findUniqueOrThrow({ where: { invocationId: invocation.id } });
  expect(result).toMatchObject({ workspaceId: input.workspaceId, consumerKind: "BOOK_ANALYSIS_EMBEDDINGS", consumerKey: run.id });
  const audit = invocation.connectionId ? await prisma.providerAuditEvent.findFirst({ where: { workspaceId: input.workspaceId, targetId: invocation.connectionId, actorUserId: input.userId, action: "CONNECTION_CREATED" } }) : null;
  expect(audit).not.toBeNull();
  return { invocation, result };
}

async function createBProductFixtures(input: { userId: string; workspaceId: string }) {
  const project = await prisma.podcastProject.create({ data: { workspaceId: input.workspaceId, name: "B private podcast" } });
  const style = await prisma.podcastStyleProfile.create({ data: { workspaceId: input.workspaceId, podcastProjectId: project.id, version: 1 } });
  const episode = await prisma.podcastEpisode.create({ data: { workspaceId: input.workspaceId, podcastProjectId: project.id, styleProfileId: style.id, title: "B private episode", language: "zh-CN", targetDurationMinutes: 5, status: "READY" } });
  const script = await prisma.podcastScriptRevision.create({ data: { workspaceId: input.workspaceId, episodeId: episode.id, revisionNumber: 1, source: "GENERATED", scriptSnapshot: { title: "B private script" }, estimatedDurationSeconds: 60, createdByUserId: input.userId } });
  await prisma.currentPodcastScript.create({ data: { workspaceId: input.workspaceId, episodeId: episode.id, revisionId: script.id } });
  const audioConfig = await prisma.podcastEpisodeAudioConfig.create({ data: { workspaceId: input.workspaceId, podcastProjectId: project.id, episodeId: episode.id, version: 1 } });
  const audioJob = await prisma.job.create({ data: { userId: input.userId, workspaceId: input.workspaceId, type: "phase7-private-audio-job", status: "SUCCEEDED", payload: {} } });
  const audioRun = await prisma.audioGenerationRun.create({ data: { workspaceId: input.workspaceId, podcastProjectId: project.id, episodeId: episode.id, scriptRevisionId: script.id, audioConfigId: audioConfig.id, jobId: audioJob.id, provider: "fixture", model: "fixture", pipelineVersion: "phase7", speechPreparationVersion: "phase7", assemblyVersion: "phase7", normalizationVersion: "phase7", outputFormat: "wav", generationIdentityHash: `phase7-audio-${project.id}`, idempotencyKey: `phase7-audio-${project.id}`, status: "SUCCEEDED", stage: "COMPLETED" } });
  const audio = await prisma.podcastAudioRevision.create({ data: { workspaceId: input.workspaceId, episodeId: episode.id, scriptRevisionId: script.id, audioGenerationRunId: audioRun.id, revisionNumber: 1, storageKey: `phase7/${input.workspaceId}/private.wav`, sha256: "fixture", format: "wav", mediaType: "audio/wav", durationMs: 1000 } });
  await prisma.currentPodcastAudio.create({ data: { workspaceId: input.workspaceId, episodeId: episode.id, revisionId: audio.id } });

  const videoProject = await prisma.shortVideoProject.create({ data: { workspaceId: input.workspaceId, name: "B private video" } });
  const videoStyle = await prisma.shortVideoStyleProfile.create({ data: { workspaceId: input.workspaceId, shortVideoProjectId: videoProject.id, version: 1 } });
  const videoJob = await prisma.job.create({ data: { userId: input.userId, workspaceId: input.workspaceId, type: "phase7-private-video-job", status: "SUCCEEDED", payload: {} } });
  const videoRun = await prisma.shortVideoGenerationRun.create({ data: { workspaceId: input.workspaceId, shortVideoProjectId: videoProject.id, styleProfileId: videoStyle.id, jobId: videoJob.id, provider: "fixture", model: "fixture", promptVersion: "phase7", pipelineVersion: "phase7", retrievalVersion: "phase7", scenePlannerVersion: "phase7", captionVersion: "phase7", audioVersion: "phase7", renderVersion: "phase7", generationIdentityHash: `phase7-video-${videoProject.id}`, idempotencyKey: `phase7-video-${videoProject.id}`, status: "SUCCEEDED", stage: "COMPLETED" } });
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  const storageKey = `phase7/${input.workspaceId}/private.mp4`;
  await createS3CompatibleStorageProvider({ endpoint: process.env.S3_ENDPOINT!, publicEndpoint: process.env.S3_PUBLIC_ENDPOINT, region: process.env.S3_REGION!, bucket: process.env.S3_BUCKET!, accessKey: process.env.S3_ACCESS_KEY!, secretKey: process.env.S3_SECRET_KEY!, forcePathStyle: true }).putObject({ key: storageKey, body: bytes, contentType: "video/mp4" });
  const video = await prisma.shortVideoRevision.create({ data: { workspaceId: input.workspaceId, shortVideoProjectId: videoProject.id, generationRunId: videoRun.id, revisionNumber: 1, storageKey, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, mediaType: "video/mp4", container: "mp4", width: 1, height: 1, fps: 1, durationMs: 1000, videoCodec: "h264", audioCodec: "aac" } });
  await prisma.currentShortVideo.create({ data: { workspaceId: input.workspaceId, shortVideoProjectId: videoProject.id, revisionId: video.id } });
  return { project, episode, audio, videoProject, video, videoJob };
}

test("real Better Auth lifecycle includes same-context expiry and real Flow C", async ({ page }) => {
  const errors = captureErrors(page);
  const email = `phase7-flow-${Date.now()}@ai-cognitive-studio.test`;
  await signUp(page, "Phase Seven", email);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true, sessions: true } });
  expect(user.sessions.length).toBeGreaterThan(0);
  expect(user.defaultWorkspaceId).toBe(user.memberships[0]!.workspaceId);
  const sourceDocumentId = await uploadBook(page, "phase7-authenticated-book.md");
  const source = await prisma.sourceDocument.findUniqueOrThrow({ where: { id: sourceDocumentId }, include: { currentIntelligence: true, ingestionRuns: true, analysisRuns: true } });
  expect(source.workspaceId).toBe(user.defaultWorkspaceId);
  expect(source.ingestionRuns.some((run) => run.status === "SUCCEEDED")).toBe(true);
  expect(source.analysisRuns.some((run) => run.status === "SUCCEEDED")).toBe(true);
  expect(source.currentIntelligence).not.toBeNull();
  await assertDurableGatewayPrincipal({ sourceDocumentId, userId: user.id, workspaceId: user.defaultWorkspaceId! });
  await prisma.session.update({ where: { id: user.sessions[0]!.id }, data: { expiresAt: new Date(0) } });
  await page.goto("/studio");
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await page.request.post("/api/studio/upload", { data: { filename: "expired.md", mediaType: "text/markdown", sizeBytes: 1 } })).status()).toBe(403);
  await signIn(page, email);
  await page.locator("summary").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(errors).toEqual([]);
});

test("supported Better Auth single-session revocation rejects only the stale victim", async ({ browser }) => {
  const email = `phase7-revoke-${Date.now()}@ai-cognitive-studio.test`;
  const victim = await signedUp(browser, "Revocation User", email);
  await victim.page.goto("/studio");
  await expect(victim.page).toHaveURL(/\/studio$/);
  const victimSession = await prisma.session.findFirstOrThrow({ where: { userId: victim.user.id }, orderBy: { createdAt: "desc" } });
  const controllerContext = await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `203.0.113.${nextTestIp++}` } });
  const controller = await controllerContext.newPage();
  await signIn(controller, email);
  await controller.goto("/studio");
  await expect(controller).toHaveURL(/\/studio$/);
  const sessions = await prisma.session.findMany({ where: { userId: victim.user.id }, orderBy: { createdAt: "asc" } });
  expect(sessions).toHaveLength(2);
  const controllerSession = sessions.find((session) => session.id !== victimSession.id);
  expect(controllerSession).toBeTruthy();
  const revoked = await controller.request.post("/api/auth/revoke-session", { data: { token: victimSession.token }, headers: { origin: "http://localhost:3000" } });
  expect(revoked.status()).toBe(200);
  expect(await prisma.session.findUnique({ where: { id: victimSession.id } })).toBeNull();
  expect(await prisma.session.findUnique({ where: { id: controllerSession!.id } })).not.toBeNull();
  await victim.page.goto("/studio");
  await expect(victim.page).toHaveURL(/\/sign-in/);
  expect((await victim.page.request.post("/api/studio/upload", { data: { filename: "revoked.md", mediaType: "text/markdown", sizeBytes: 1 } })).status()).toBe(403);
  await controller.goto("/studio");
  await expect(controller).toHaveURL(/\/studio$/);
  await victim.context.close();
  await controllerContext.close();
});

test("two real users cannot cross tenant boundaries, while members can switch and private media is authorized", async ({ browser }) => {
  const suffix = Date.now();
  const b = await signedUp(browser, "Tenant B", `phase7-b-${suffix}@ai-cognitive-studio.test`);
  const bSourceId = await uploadBook(b.page, "b-tenant-evidence.md");
  const bGateway = await assertDurableGatewayPrincipal({ sourceDocumentId: bSourceId, userId: b.user.id, workspaceId: b.workspaceId });
  const firstRun = await prisma.bookAnalysisRun.findFirstOrThrow({ where: { job: { user: { email: { startsWith: "phase7-flow-" } } }, status: "SUCCEEDED" }, include: { job: true }, orderBy: { createdAt: "desc" } });
  const firstInvocation = await prisma.providerInvocation.findFirstOrThrow({ where: { workspaceId: firstRun.workspaceId, idempotencyKey: `book-analysis-embeddings:${firstRun.id}` } });
  expect(firstRun.workspaceId).not.toBe(b.workspaceId);
  expect(firstInvocation.workspaceId).not.toBe(bGateway.invocation.workspaceId);
  const fixture = await createBProductFixtures({ userId: b.user.id, workspaceId: b.workspaceId });
  const a = await signedUp(browser, "Tenant A", `phase7-a-${suffix}@ai-cognitive-studio.test`);

  const forbiddenSource = await a.page.request.get(`/studio/library/${bSourceId}`);
  expect(forbiddenSource.status()).toBe(404);
  expect(await forbiddenSource.text()).not.toContain("b-tenant-evidence.md");
  expect((await b.page.request.get(`/studio/library/${bSourceId}`)).status()).toBe(200);
  expect((await a.page.request.get(`/studio/podcasts/${fixture.episode.id}`)).status()).toBe(404);
  expect((await b.page.request.get(`/studio/podcasts/${fixture.episode.id}`)).status()).toBe(200);
  expect((await a.page.request.get(`/studio/videos/${fixture.videoProject.id}`)).status()).toBe(404);
  expect((await b.page.request.get(`/studio/videos/${fixture.videoProject.id}`)).status()).toBe(200);
  const aActivity = await a.page.request.get("/studio/activity");
  expect(aActivity.status()).toBe(200);
  expect(await aActivity.text()).not.toContain("phase7-private-video-job");
  expect((await b.page.request.get("/studio/activity")).status()).toBe(200);
  const deniedMedia = await a.page.request.get(`/api/studio/media/video/${fixture.video.id}`);
  expect(deniedMedia.status()).toBe(404);
  expect(await deniedMedia.text()).not.toContain("private.mp4");
  const allowedMedia = await b.page.request.get(`/api/studio/media/video/${fixture.video.id}`);
  expect(allowedMedia.status()).toBe(200);
  expect(allowedMedia.headers()["content-type"]).toContain("video/mp4");
  expect((await allowedMedia.body()).byteLength).toBeGreaterThan(0);

  const rawWorkspace = await a.page.request.post("/api/studio/workspace", { data: { workspaceId: b.workspaceId, userId: b.user.id }, headers: { "x-user-id": b.user.id, "x-workspace-id": b.workspaceId } });
  expect(rawWorkspace.status()).toBe(403);
  await a.context.addCookies([{ name: "acs_active_workspace", value: b.workspaceId, url: "http://localhost:3000", httpOnly: true, sameSite: "Lax" }]);
  const rawCookieDashboard = await a.page.request.get("/studio");
  expect(rawCookieDashboard.status()).toBe(200);
  expect(await rawCookieDashboard.text()).not.toContain("b-tenant-evidence.md");
  const a2 = await prisma.workspace.create({ data: { name: "Tenant A secondary", members: { create: { userId: a.user.id, role: "EDITOR" } } } });
  expect((await a.page.request.post("/api/studio/workspace", { data: { workspaceId: a2.id } })).status()).toBe(200);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).defaultWorkspaceId).toBe(a2.id);
  expect((await a.page.request.post("/api/studio/workspace", { data: { workspaceId: a.workspaceId } })).status()).toBe(200);
  expect((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).defaultWorkspaceId).toBe(a.workspaceId);
  await a.context.close();
  await b.context.close();
});

test("auth forms are responsive and labelled", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/sign-up");
  await expect(page.locator('input[autocomplete="name"]')).toBeVisible();
  await expect(page.locator('input[autocomplete="email"]')).toBeVisible();
  await expect(page.locator('input[autocomplete="new-password"]')).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});

test("authentication ignores untrusted callback URLs", async ({ browser }) => {
  const account = await signedUp(browser, "Callback Safety", `phase7-callback-${Date.now()}@ai-cognitive-studio.test`);
  await account.page.locator("summary").click();
  await account.page.getByRole("button", { name: "Sign out" }).click();
  await expect(account.page).toHaveURL(/\/sign-in$/);
  for (const callbackUrl of ["https://evil.example", "//evil.example", "https%3A%2F%2Fevil.example", "javascript:alert(1)"]) {
    await account.page.goto(`/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`);
    expect(new URL(account.page.url()).origin).toBe("http://localhost:3000");
    await expect(account.page.locator('input[name="email"]')).toBeVisible();
  }
  await account.page.locator('input[name="email"]').fill(account.user.email);
  await account.page.locator('input[name="password"]').fill(password);
  await account.page.locator('button[type="submit"]').click();
  await expect(account.page).toHaveURL(/\/studio$/);
  await account.context.close();
});

test("forged and random Better Auth cookies cannot pass protected boundaries", async ({ browser }) => {
  const context = await browser.newContext();
  await context.addCookies([{ name: "better-auth.session_token", value: "forged-session-token-that-is-not-persisted", url: "http://localhost:3000", httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto("/studio");
  await expect(page).toHaveURL(/\/sign-in/);
  expect((await page.request.post("/api/studio/upload", { data: { filename: "attack.md", mediaType: "text/markdown", sizeBytes: 1 } })).status()).toBe(403);
  await context.close();
});
