import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const root = process.cwd();
const database = "ai_cognitive_studio_phase17_test";
const port = process.env.POSTGRES_HOST_PORT ?? (process.platform === "win32" ? "5433" : "5432");
const artifactGitSha = process.env.PHASE17_ARTIFACT_GIT_SHA ?? process.env.GITHUB_SHA ?? "LOCAL_UNBOUND";
const environment = { ...process.env, NODE_ENV: "test", DATABASE_URL: `postgresql://app:app@localhost:${port}/${database}?schema=public`, DATABASE_URL_TEST: `postgresql://app:app@localhost:${port}/${database}?schema=public`, BETTER_AUTH_SECRET: "phase17-test-secret-must-be-at-least-32-characters", BETTER_AUTH_URL: "http://localhost:3001", BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3001", BETTER_AUTH_ALLOW_LOCALHOST_HTTP_FOR_TESTS: "true", BETTER_AUTH_TEST_RATE_LIMIT_MAX: "1000", WEB_DEV_BOOTSTRAP_IDENTITY: "false", BETA_ACCESS_MODE: "ENFORCED", PHASE17_ARTIFACT_GIT_SHA: artifactGitSha, ...(process.platform === "win32" ? { PHASE15_POSTGRES_CONTAINER: process.env.PHASE15_POSTGRES_CONTAINER ?? "ai-cognitive-studio-postgres-1" } : {}) };
function command(args) { const result = process.platform === "win32" ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], { cwd: root, env: environment, stdio: "inherit", shell: false }) : spawnSync("pnpm", args, { cwd: root, env: environment, stdio: "inherit", shell: false }); if (result.status !== 0) throw new Error(`PHASE17_COMMAND_FAILED:pnpm ${args.join(" ")}`); }
function postgres(sql) { if (process.platform === "win32") return execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "app", "-d", "postgres", "-c", sql], { cwd: root, env: environment, stdio: "inherit" }); return execFileSync("psql", ["-h", "localhost", "-p", port, "-U", "app", "-d", "postgres", "-c", sql], { cwd: root, env: { ...environment, PGPASSWORD: "app" }, stdio: "inherit" }); }
try {
  postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`); postgres(`CREATE DATABASE ${database};`);
  command(["db:migrate:deploy"]); command(["db:migrate:deploy"]);
  command(["test:phase17:metrics"]); command(["--filter", "@ai-cognitive/web", "test:integration"]); command(["--filter", "@ai-cognitive/web", "build"]); command(["--filter", "@ai-cognitive/web", "exec", "playwright", "test", "--config", "playwright.phase17.config.ts"]);
  command(["exec", "tsx", "scripts/generate-phase17-artifact.ts"]);
  mkdirSync("output/phase17", { recursive: true });
  writeFileSync("output/phase17/release-status.json", `${JSON.stringify({ status: "PASSED", database, migrationDeploys: 2, artifactGitSha }, null, 2)}\n`);
} catch (error) {
  mkdirSync("output/phase17", { recursive: true });
  writeFileSync("output/phase17/release-status.json", `${JSON.stringify({ status: "FAILED", database, artifactGitSha, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  throw error;
} finally {
  postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
}
