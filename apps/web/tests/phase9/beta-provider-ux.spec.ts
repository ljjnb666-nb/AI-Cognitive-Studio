import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@ai-cognitive/db";

const password = "BetaProviderPassword!1";
const email = (label: string) => `beta-provider-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@ai-cognitive-studio.test`;
const execFileAsync = promisify(execFile);

async function signUp(page: import("@playwright/test").Page, value: string) {
  await page.goto("/sign-up");
  await page.locator('input[name="name"]').fill("Beta Provider Owner");
  await page.locator('input[name="email"]').fill(value);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="confirmPassword"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/studio$/);
}

async function ownerWorkspace(value: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: value }, include: { memberships: true } });
  expect(user.memberships).toHaveLength(1);
  expect(user.memberships[0]?.role).toBe("OWNER");
  return { userId: user.id, workspaceId: user.memberships[0]!.workspaceId };
}

test("fresh zero-env owner saves an encrypted built-in Provider, configures routes, and a worker independently decrypts it", async ({ page }) => {
  const secret = "beta-browser-secret-never-returned", account = email("openai");
  await signUp(page, account);
  const { userId, workspaceId } = await ownerWorkspace(account);
  await page.goto("/studio/settings/providers");
  await expect(page.getByRole("heading", { name: "AI 服务商设置" })).toBeVisible();
  // Latest UI saves a provider key separately from model-route assignments.
  // Scope queries to the provider creation form, not other route forms.
  const providerForm = page.locator("form").filter({ has: page.getByRole("button", { name: "保存服务商" }) });
  const providerType = providerForm.locator("#new-provider");
  await expect(providerType).toHaveValue("openai");
  await expect(providerType).toContainText("DeepSeek");
  await expect(page.getByText("OPENAI_RESPONSES", { exact: true })).toBeHidden();
  await expect(page.getByText("BOOK_CHUNK_ANALYSIS", { exact: false })).toBeHidden();

  await providerForm.getByText("更多服务商设置（可选）").click();
  await providerForm.locator('input[name="displayName"]').fill("Zero env OpenAI");
  await providerForm.locator('input[name="secret"]').fill(secret);
  await providerForm.getByRole("button", { name: "验证 API Key" }).click();
  await expect(page.getByText(/API Key 身份验证通过/)).toBeVisible();
  await providerForm.getByRole("button", { name: "保存服务商" }).click();
  await expect(page.getByRole("heading", { name: "Zero env OpenAI" })).toBeVisible();

  const connection = await prisma.providerConnection.findFirstOrThrow({ where: { workspaceId, displayName: "Zero env OpenAI" } });
  const beforeAuto = await prisma.providerCredentialVersion.findFirstOrThrow({ where: { workspaceId, connectionId: connection.id } });
  expect(JSON.stringify({ connection, beforeAuto })).not.toContain(secret);
  expect(beforeAuto.ciphertext).not.toContain(secret);
  expect(beforeAuto.displayHint ?? "").not.toContain(secret);
  // Saving a key must not silently bind models. In the current product,
  // routes are chosen explicitly, so configure one representative text route
  // through the real advanced settings UI before proving worker decryption.
  expect(await prisma.providerRouteBinding.count({ where: { workspaceId } })).toBe(0);
  await page.getByText("模型与用途配置（高级设置）").click();
  const chunkRoute = page.locator("#route-BOOK_CHUNK_ANALYSIS");
  const modelSelect = chunkRoute.locator('select[name="modelId"]');
  await expect(modelSelect.locator('option:not([disabled])')).not.toHaveCount(0);
  await modelSelect.selectOption({ index: 1 });
  await chunkRoute.getByRole("button", { name: "保存路由" }).click();
  await expect.poll(() => prisma.providerRouteBinding.count({ where: { workspaceId, routeSlot: "BOOK_CHUNK_ANALYSIS" } })).toBe(1);

  const routes = await prisma.providerRouteBinding.findMany({ where: { workspaceId }, orderBy: { routeSlot: "asc" } });
  expect(routes.map(route => route.routeSlot)).toEqual(["BOOK_CHUNK_ANALYSIS"]);
  expect(routes.filter(route => route.routeSlot.endsWith("TTS"))).toHaveLength(0);
  expect(JSON.stringify(routes)).not.toContain(secret);
  const credentials = await prisma.providerCredentialVersion.findMany({ where: { workspaceId } });
  expect(JSON.stringify(credentials)).not.toContain(secret);
  const response = await page.request.get("/api/studio/providers");
  expect(response.ok()).toBeTruthy();
  const product = await response.text();
  expect(product).not.toContain(secret);
  expect(JSON.parse(product).readiness.book.state).toBe("READY");
  expect(await page.content()).not.toContain(secret);

  const workerEnvironment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", BETA_PROVIDER_UX_WORKSPACE_ID: workspaceId, BETA_PROVIDER_UX_USER_ID: userId };
  delete workerEnvironment.PROVIDER_GATEWAY_MODEL_MANIFEST;
  delete workerEnvironment.PROVIDER_GATEWAY_KEYRING;
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "tests/beta-provider-ux-worker-proof.ts"], { cwd: "../worker", env: workerEnvironment });
  const workerProof = JSON.parse(stdout.trim()) as { status: string; credentialHash: string };
  expect(workerProof.status).toBe("SUCCEEDED");
  expect(workerProof.credentialHash).toBe(createHash("sha256").update(secret).digest("hex"));
});

test("JSON-mode DeepSeek never auto-binds Teach Back", async ({ page }) => {
  const account = email("deepseek");
  await signUp(page, account);
  const { workspaceId } = await ownerWorkspace(account);
  await page.goto("/studio/settings/providers");
  await expect(page.getByRole("heading", { name: "AI 服务商设置" })).toBeVisible();
  const providerForm = page.locator("form").filter({ has: page.getByRole("button", { name: "保存服务商" }) });
  const providerType = providerForm.locator("#new-provider");
  await providerType.selectOption("deepseek");
  await providerForm.getByText("更多服务商设置（可选）").click();
  await providerForm.locator('input[name="displayName"]').fill("Zero env DeepSeek");
  await providerForm.locator('input[name="secret"]').fill("beta-deepseek-secret");
  await providerForm.getByRole("button", { name: "验证 API Key" }).click();
  await expect(page.getByText(/API Key 身份验证通过/)).toBeVisible();
  await providerForm.getByRole("button", { name: "保存服务商" }).click();
  await expect(page.getByRole("heading", { name: "Zero env DeepSeek" })).toBeVisible();
  // Save-only is intentionally inert for route bindings. JSON-mode models
  // must never be implicitly promoted into strict-schema Teach Back routes.
  expect(await prisma.providerRouteBinding.count({ where: { workspaceId } })).toBe(0);
  expect(await prisma.providerRouteBinding.count({ where: { workspaceId, routeSlot: "TEACH_BACK_ASSESSMENT" } })).toBe(0);
  expect(await prisma.providerRouteBinding.count({ where: { workspaceId, routeSlot: { in: ["PODCAST_TTS", "SHORT_VIDEO_TTS"] } } })).toBe(0);
});
