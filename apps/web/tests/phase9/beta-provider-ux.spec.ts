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

/** The restored setup UI saves a provider; explicit model routes are edited separately.
 * The legacy auto-configuration API remains supported for migration/backward compatibility,
 * but is deliberately no longer shown as a one-click new-user action. */
async function saveProviderInRestoredUi(page: import("@playwright/test").Page, providerKey: string, displayName: string, secret: string) {
  await page.goto("/studio/settings/providers");
  await expect(page.getByRole("heading", { name: "AI 服务商设置" })).toBeVisible();
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "保存服务商" }) });
  const provider = form.locator("select#new-provider");
  await expect(provider).toBeVisible();
  await provider.selectOption(providerKey);
  await form.getByText("更多服务商设置（可选）").click();
  await form.locator('input[name="displayName"]').fill(displayName);
  await form.locator('input[name="secret"]').fill(secret);
  await form.getByRole("button", { name: "验证 API Key" }).click();
  await expect(page.getByText("✓ API Key 身份验证通过，可保存服务商；具体模型权限以实际调用为准。")).toBeVisible();
  await form.getByRole("button", { name: "保存服务商" }).click();
  await expect(page.getByRole("heading", { name: displayName })).toBeVisible();
}

async function fillUnboundRoutesViaCompatibilityApi(page: import("@playwright/test").Page, connectionId: string) {
  const response = await page.request.post("/api/studio/providers", {
    data: { action: "AUTO_CONFIGURE_ROUTES", connectionId },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const data = await response.json() as { autoConfigure?: { bound?: string[] } };
  expect(Array.isArray(data.autoConfigure?.bound)).toBe(true);
}

test("fresh zero-env owner saves an encrypted built-in Provider, configures routes, and a worker independently decrypts it", async ({ page }) => {
  const secret = "beta-browser-secret-never-returned", account = email("openai");
  await signUp(page, account);
  const { userId, workspaceId } = await ownerWorkspace(account);
  await saveProviderInRestoredUi(page, "openai", "Zero env OpenAI", secret);
  await expect(page.locator("#new-provider")).toContainText("DeepSeek");
  await expect(page.getByText("OPENAI_RESPONSES", { exact: true })).toBeHidden();
  await expect(page.getByText("BOOK_CHUNK_ANALYSIS", { exact: false })).toBeHidden();

  const connection = await prisma.providerConnection.findFirstOrThrow({ where: { workspaceId, displayName: "Zero env OpenAI" } });
  const beforeAuto = await prisma.providerCredentialVersion.findFirstOrThrow({ where: { workspaceId, connectionId: connection.id } });
  expect(JSON.stringify({ connection, beforeAuto })).not.toContain(secret);
  expect(beforeAuto.ciphertext).not.toContain(secret);
  expect(beforeAuto.displayHint ?? "").not.toContain(secret);
  // Verify that the new advanced route editor actually binds a selected model.
  await page.getByText("模型与用途配置（高级设置）").click();
  const bookRoute = page.locator("form#route-BOOK_CHUNK_ANALYSIS");
  await bookRoute.locator('select[name="modelId"]').selectOption("gpt-5.4-mini");
  await bookRoute.getByRole("button", { name: "保存路由" }).click();
  await expect(bookRoute.getByText("用途配置已保存。")).toBeVisible();
  // Exercise the supported compatibility API to fill only still-unbound routes.
  await fillUnboundRoutesViaCompatibilityApi(page, connection.id);

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
  await saveProviderInRestoredUi(page, "deepseek", "Zero env DeepSeek", "beta-deepseek-secret");
  await page.getByText("模型与用途配置（高级设置）").click();
  await expect(page.locator("form#route-TEACH_BACK_ASSESSMENT").getByText("当前服务商没有可用于理解验证的兼容模型。", { exact: false })).toBeVisible();
  const connection = await prisma.providerConnection.findFirstOrThrow({ where: { workspaceId, displayName: "Zero env DeepSeek" } });
  await fillUnboundRoutesViaCompatibilityApi(page, connection.id);
  expect(await prisma.providerRouteBinding.count({ where: { workspaceId, routeSlot: "TEACH_BACK_ASSESSMENT" } })).toBe(0);
  expect(await prisma.providerRouteBinding.count({ where: { workspaceId, routeSlot: { in: ["PODCAST_TTS", "SHORT_VIDEO_TTS"] } } })).toBe(0);
});
