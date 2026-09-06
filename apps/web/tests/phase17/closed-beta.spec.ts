import { expect, test } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";
import { createBetaInvite } from "@ai-cognitive/product-analytics";

const password = "Phase17Password!";

async function podcastFixture(userId: string, workspaceId: string, suffix: string) {
  const project = await prisma.podcastProject.create({ data: { workspaceId, name: `phase17 ${suffix}` } });
  const style = await prisma.podcastStyleProfile.create({ data: { workspaceId, podcastProjectId: project.id, version: 1 } });
  const episode = await prisma.podcastEpisode.create({ data: { workspaceId, podcastProjectId: project.id, styleProfileId: style.id, title: `phase17 ${suffix}`, language: "zh-CN", targetDurationMinutes: 1, status: "READY" } });
  const script = await prisma.podcastScriptRevision.create({ data: { workspaceId, episodeId: episode.id, revisionNumber: 1, source: "GENERATED", scriptSnapshot: {}, estimatedDurationSeconds: 1, createdByUserId: userId } });
  await prisma.currentPodcastScript.create({ data: { workspaceId, episodeId: episode.id, revisionId: script.id } });
  const config = await prisma.podcastEpisodeAudioConfig.create({ data: { workspaceId, podcastProjectId: project.id, episodeId: episode.id, version: 1 } });
  const job = await prisma.job.create({ data: { userId, workspaceId, type: `phase17-audio-${suffix}`, status: "SUCCEEDED", payload: {} } });
  const run = await prisma.audioGenerationRun.create({ data: { workspaceId, podcastProjectId: project.id, episodeId: episode.id, scriptRevisionId: script.id, audioConfigId: config.id, jobId: job.id, provider: "fixture", model: "fixture", pipelineVersion: "phase17", speechPreparationVersion: "phase17", assemblyVersion: "phase17", normalizationVersion: "phase17", outputFormat: "wav", generationIdentityHash: `phase17-${suffix}`, idempotencyKey: `phase17-${suffix}`, status: "SUCCEEDED", stage: "COMPLETED" } });
  const audio = await prisma.podcastAudioRevision.create({ data: { workspaceId, episodeId: episode.id, scriptRevisionId: script.id, audioGenerationRunId: run.id, revisionNumber: 1, storageKey: `phase17/${suffix}.wav`, sha256: suffix, format: "wav", mediaType: "audio/wav", durationMs: 1000 } });
  await prisma.currentPodcastAudio.create({ data: { workspaceId, episodeId: episode.id, revisionId: audio.id } });
  return { episode, audio };
}

test("enforced beta blocks provisioning until consented invite redemption, then admits the same account", async ({ page }) => {
  const email = `phase17-${Date.now()}@ai-cognitive-studio.test`;
  await page.goto("/sign-up");
  await page.locator('input[name="name"]').fill("Phase Seventeen");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  await page.getByRole("button", { name: "注册并进入 Studio" }).click();
  await expect(page).toHaveURL(/\/beta\/access$/);
  const user = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  expect(user.memberships).toHaveLength(0);
  const { token } = await createBetaInvite({ cohort: "browser-acceptance", expiresAt: new Date(Date.now() + 60_000) });
  await page.getByLabel("邀请码").fill(token);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "接受邀请并进入" }).click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect.poll(async () => (await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } })).memberships.length).toBe(1);
  await expect(page.getByRole("button", { name: "反馈 / Feedback" })).toBeVisible();
  await page.getByRole("button", { name: "反馈 / Feedback" }).click();
  await page.getByLabel("告诉我们哪里需要改进（可选）").fill("phase17 durable feedback");
  await page.getByRole("button", { name: "提交" }).click();
  await expect(page.getByRole("status")).toHaveText("感谢反馈。");
  const beta = await prisma.betaParticipant.findUniqueOrThrow({ where: { userId: user.id } });
  await expect.poll(() => prisma.betaFeedback.count({ where: { participantId: beta.id, message: "phase17 durable feedback" } })).toBe(1);
  await prisma.betaParticipant.update({ where: { id: beta.id }, data: { role: "OPERATOR" } });
  await page.goto("/studio/beta");
  await expect(page.getByRole("heading", { name: "Beta 概览" })).toBeVisible();
  await prisma.betaParticipant.update({ where: { id: beta.id }, data: { role: "TESTER" } });
  await page.goto("/studio/beta");
  await expect(page).toHaveURL(/\/studio$/);

  const liveUser = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true } });
  const normal = await podcastFixture(liveUser.id, liveUser.memberships[0]!.workspaceId, "normal");
  await page.goto(`/studio/podcasts/${normal.episode.id}`);
  await page.locator("audio").evaluate((element) => { const audio = element as HTMLAudioElement; Object.defineProperty(audio, "duration", { configurable: true, value: 1 }); Object.defineProperty(audio, "currentTime", { configurable: true, writable: true, value: 0 }); audio.dispatchEvent(new Event("loadedmetadata")); audio.dispatchEvent(new Event("play")); audio.currentTime = .3; audio.dispatchEvent(new Event("timeupdate")); });
  await expect.poll(() => prisma.productEvent.count({ where: { participantId: beta.id, entityId: normal.audio.id, eventName: "PODCAST_PLAYBACK_25" } })).toBe(1);

  const seek = await podcastFixture(liveUser.id, liveUser.memberships[0]!.workspaceId, "seek");
  await page.goto(`/studio/podcasts/${seek.episode.id}`);
  await page.locator("audio").evaluate((element) => { const audio = element as HTMLAudioElement; Object.defineProperty(audio, "duration", { configurable: true, value: 1 }); Object.defineProperty(audio, "currentTime", { configurable: true, writable: true, value: 0 }); audio.dispatchEvent(new Event("loadedmetadata")); audio.dispatchEvent(new Event("play")); audio.currentTime = .95; audio.dispatchEvent(new Event("seeking")); audio.dispatchEvent(new Event("seeked")); audio.dispatchEvent(new Event("timeupdate")); });
  await expect.poll(() => prisma.productEvent.count({ where: { participantId: beta.id, entityId: seek.audio.id, eventName: { in: ["PODCAST_PLAYBACK_25", "PODCAST_PLAYBACK_50", "PODCAST_PLAYBACK_75", "PODCAST_PLAYBACK_90"] } } })).toBe(0);
});
