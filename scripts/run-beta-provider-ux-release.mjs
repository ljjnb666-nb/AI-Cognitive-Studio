import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const database = "ai_cognitive_studio_beta_provider_ux_test";
const port = process.env.POSTGRES_HOST_PORT ?? "5433";
const suffix = randomBytes(8).toString("hex");
const localKeyring = resolve(root, `.runtime/secrets/beta-provider-ux-${suffix}.json`);
const environment = { ...process.env, NODE_ENV: "development", DATABASE_URL: `postgresql://app:app@localhost:${port}/${database}?schema=public`, DATABASE_URL_TEST: `postgresql://app:app@localhost:${port}/${database}?schema=public`, BETTER_AUTH_SECRET: "beta-provider-ux-secret-must-be-at-least-32-characters", BETTER_AUTH_URL: "http://localhost:3001", BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3001", WEB_DEV_BOOTSTRAP_IDENTITY: "false", PHASE6_BROWSER_ACCEPTANCE: "false", PROVIDER_GATEWAY_LOCAL_KEYRING_PATH: localKeyring, BETA_PROVIDER_UX_TEST_CONNECTION_TRANSPORT: "deterministic" };
delete environment.PROVIDER_GATEWAY_MODEL_MANIFEST;
delete environment.PROVIDER_GATEWAY_KEYRING;
function command(program, args) { const result = process.platform === "win32" && program === "pnpm" ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], { cwd: root, env: environment, stdio: "inherit", shell: false }) : spawnSync(program, args, { cwd: root, env: environment, stdio: "inherit", shell: false }); if (result.status !== 0) throw new Error(`BETA_PROVIDER_UX_COMMAND_FAILED:${program}`); }
function postgres(sql) { const container = process.env.PHASE9_POSTGRES_CONTAINER; if (container) { execFileSync("docker", ["exec", "-i", container, "psql", "-U", "app", "-d", "postgres", "-c", sql], { cwd: root, env: environment, stdio: "inherit" }); return; } try { execFileSync("psql", ["-h", "localhost", "-p", port, "-U", "app", "-d", "postgres", "-c", sql], { cwd: root, env: { ...environment, PGPASSWORD: "app" }, stdio: "inherit" }); } catch { command("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "app", "-d", "postgres", "-c", sql]); } }
try {
  postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
  postgres(`CREATE DATABASE ${database};`);
  command("pnpm", ["db:migrate:deploy"]);
  command("pnpm", ["--filter", "@ai-cognitive/web", "exec", "playwright", "test", "--config", "playwright.beta-provider-ux.config.ts"]);
} finally {
  await rm(localKeyring, { force: true });
  if (existsSync("node_modules")) postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
}
