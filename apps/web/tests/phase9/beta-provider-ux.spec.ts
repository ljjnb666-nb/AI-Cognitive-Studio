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
  await expect(page.getByRole("heading", { name: "AI Providers" })).toBeVisible();
  // The Provider creation form is identified by its business action, not DOM
  // order: the settings page also hosts the stable-config route form, whose
  // own selects precede this form in the document.
  const providerForm = page.locator("form").filter({ has: page.getByRole("button", { name: "保存 Provider" }) });
  const providerType = providerForm.locator('label:text-is("提供商 (Provider)") + select');
  await expect(providerType).toHaveValue("openai");
  await expect(providerType).toContainText("DeepSeek");
  await expect(page.getByText("OPENAI_RESPONSES", { exact: true })).toBeHidden();
  await expect(page.getByText("BOOK_CHUNK_ANALYSIS", { exact: false })).toBeHidden();

  await providerForm.locator('input[name="displayName"]').fill("Zero env OpenAI");
  await providerForm.locator('input[name="secret"]').fill(secret);
  await providerForm.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByText("✓ API Key 可用，确认后点击保存 Provider。")).toBeVisible();
  await providerForm.getByRole("button", { name: "保存 Provider" }).click();
  await expect(page.getByRole("heading", { name: "Zero env OpenAI" })).toBeVisible();

  const connection = await prisma.providerConnection.findFirstOrThrow({ where: { workspaceId, displayName: "Zero env OpenAI" } });
  const beforeAuto = await prisma.providerCredentialVersion.findFirstOrThrow({ where: { workspaceId, connectionId: connection.id } });
  expect(JSON.stringify({ connection, beforeAuto })).not.toContain(secret);
  expect(beforeAuto.ciphertext).not.toContain(secret);
  expect(beforeAuto.displayHint ?? "").not.toContain(secret);
  await page.getByRole("button", { name: "填补未绑定的默认路由" }).click();
  await expect(page.getByText(/已自动配置 8 个推荐用途/)).toBeVisible();

  const routes = await prisma.providerRouteBinding.findMany({ where: { workspaceId }, orderBy: { routeSlot: "asc" } });
  expect(routes.map(route => route.routeSlot)).toEqual(["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING", "PODCAST_SCRIPT", "SHORT_VIDEO_SCRIPT", "TEACH_BACK_ASSESSMENT", "THINKING_SESSION"]);
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
  const providerForm = page.locator("form").filter({ has: page.getByRole("button", { name: "保存 Provider" }) });
  const providerType = providerForm.locator('label:text-is("提供商 (Provider)") + select');
  await providerType.selectOption("deepseek");
  await providerForm.locator('input[name="displayName"]').fill("Zero env DeepSeek");
  await providerForm.locator('input[name="secret"]').fill("beta-deepseek-secret");
  await providerForm.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByText("✓ API Key 可用，确认后点击保存 Provider。")).toBeVisible();
  await providerForm.getByRole("button", { name: "保存 Provider" }).click();
  await page.getByRole("button", { name: "填补未绑定的默认路由" }).click();
  expect(await prisma.providerRouteBinding.count({ where: { workspaceId, routeSlot: "TEACH_BACK_ASSESSMENT" } })).toBe(0);
  expect(await prisma.providerRouteBinding.count({ where: { workspaceId, routeSlot: { in: ["PODCAST_TTS", "SHORT_VIDEO_TTS"] } } })).toBe(0);
});
