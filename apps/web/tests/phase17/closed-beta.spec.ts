import { expect, test } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";
import { createBetaInvite } from "@ai-cognitive/product-analytics";

const password = "Phase17Password!";

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
});
