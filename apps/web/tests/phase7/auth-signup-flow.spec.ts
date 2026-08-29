import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@ai-cognitive/db";

const password = "Phase95Password!";

async function fillSignUp(page: Page, input: { name: string; email: string }) {
  await page.locator('input[name="name"]').fill(input.name);
  await page.locator('input[name="email"]').fill(input.email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
}

async function fillSignIn(page: Page, email: string, value: string) {
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(value);
}

test("Better Auth sign-up establishes one usable session without a redundant sign-in", async ({ page }) => {
  const email = `phase95-auth-${Date.now()}@ai-cognitive-studio.test`;
  const signUpResponses: number[] = [];
  const signInResponses: number[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith("/api/auth/sign-up/email")) signUpResponses.push(response.status());
    if (response.url().endsWith("/api/auth/sign-in/email")) signInResponses.push(response.status());
  });

  await page.goto("/sign-up");
  await fillSignUp(page, { name: "Phase Nine Five", email });
  await page.getByRole("button", { name: "注册并进入 Studio" }).click();
  await expect(page).toHaveURL(/\/studio$/);
  await expect.poll(() => signUpResponses).toEqual([200]);
  expect(signInResponses).toEqual([]);

  const created = await prisma.user.findUniqueOrThrow({ where: { email }, include: { memberships: true, sessions: true } });
  expect(created.memberships).toHaveLength(1);
  expect(created.sessions).toHaveLength(1);
  expect(await prisma.user.count({ where: { email } })).toBe(1);

  await page.context().clearCookies();
  await page.goto("/sign-up");
  await fillSignUp(page, { name: "Phase Nine Five", email });
  const duplicateResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-up/email"));
  await page.getByRole("button", { name: "注册并进入 Studio" }).click();
  const duplicate = await duplicateResponse;
  expect(duplicate.status()).toBe(422);
  await expect(duplicate.json()).resolves.toMatchObject({ code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
  await expect(page).toHaveURL(/\/sign-up$/);
  await expect(page.getByText("该邮箱已经注册，请直接登录。")).toBeVisible();
  expect(await prisma.user.count({ where: { email } })).toBe(1);

  await page.goto("/sign-in");
  await fillSignIn(page, email, password);
  const correctPasswordResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-in/email"));
  await page.getByRole("button", { name: "登录并进入工作台" }).click();
  expect((await correctPasswordResponse).status()).toBe(200);
  await expect(page).toHaveURL(/\/studio$/);

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await fillSignIn(page, email, "WrongPhase95Password!");
  const wrongPasswordResponse = page.waitForResponse((response) => response.url().endsWith("/api/auth/sign-in/email"));
  await page.getByRole("button", { name: "登录并进入工作台" }).click();
  const wrongPassword = await wrongPasswordResponse;
  expect(wrongPassword.status()).toBe(401);
  await expect(wrongPassword.json()).resolves.toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText("邮箱或密码不正确。")).toBeVisible();
});
