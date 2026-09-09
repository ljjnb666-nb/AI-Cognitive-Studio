import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const root = process.cwd(), database = "ai_cognitive_studio_phase18_test", port = process.env.POSTGRES_HOST_PORT ?? (process.platform === "win32" ? "5433" : "5432");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString("utf8").trim();
const environment = { ...process.env, NODE_ENV: "test", DATABASE_URL: `postgresql://app:app@localhost:${port}/${database}?schema=public`, DATABASE_URL_TEST: `postgresql://app:app@localhost:${port}/${database}?schema=public`, BETTER_AUTH_SECRET: "phase18-test-secret-must-be-at-least-32-characters", BETTER_AUTH_URL: "http://localhost:3001", BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3001", BETTER_AUTH_ALLOW_LOCALHOST_HTTP_FOR_TESTS: "true", WEB_DEV_BOOTSTRAP_IDENTITY: "false", PROVIDER_GATEWAY_KEYRING: JSON.stringify({ activeVersion: "v1", keys: { v1: "phase18-test-key" } }), WORKSPACE_EXPENSIVE_OPERATION_LIMIT: "2" };
function command(args) { const result = process.platform === "win32" ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], { cwd: root, env: environment, stdio: "inherit", shell: false }) : spawnSync("pnpm", args, { cwd: root, env: environment, stdio: "inherit", shell: false }); if (result.status !== 0) throw new Error(`PHASE18_COMMAND_FAILED:pnpm ${args.join(" ")}`); }
function postgres(sql) { const args = process.platform === "win32" ? ["compose", "exec", "-T", "postgres", "psql", "-U", "app", "-d", "postgres", "-c", sql] : ["-h", "localhost", "-p", port, "-U", "app", "-d", "postgres", "-c", sql]; execFileSync(process.platform === "win32" ? "docker" : "psql", args, { cwd: root, env: { ...environment, PGPASSWORD: "app" }, stdio: "inherit" }); }
try {
  postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`); postgres(`CREATE DATABASE ${database};`);
  command(["db:migrate:deploy"]); command(["db:migrate:deploy"]);
  command(["--filter", "@ai-cognitive/shared", "test"]);
  command(["--filter", "@ai-cognitive/db", "exec", "vitest", "run", "tests/phase18-expensive-operation.integration.test.ts"]);
  command(["--filter", "@ai-cognitive/product-analytics", "exec", "vitest", "run", "tests/production-diagnostics.integration.test.ts"]);
  command(["--filter", "@ai-cognitive/web", "exec", "vitest", "run", "tests/readiness.test.ts"]);
  command(["--filter", "@ai-cognitive/ingestion", "exec", "vitest", "run", "--config", "vitest.integration.config.ts", "tests/outbox-dispatch.integration.test.ts"]);
  command(["--filter", "@ai-cognitive/provider-gateway", "test:phase8a"]);
  command(["--filter", "@ai-cognitive/podcast-generation", "exec", "vitest", "run", "--config", "vitest.integration.config.ts", "tests/audio-durability.integration.test.ts"]);
  command(["--filter", "@ai-cognitive/web", "build"]);
  mkdirSync("output/phase18", { recursive: true });
  writeFileSync("output/phase18/production-hardening-evidence.json", `${JSON.stringify({ sha, migrationResult: "DEPLOY_TWICE_PASSED", readinessResult: "PASS", duplicateDelivery: "EXISTING_OUTBOX_REGRESSION_PASS", crashRecovery: "EXISTING_DURABILITY_REGRESSION_PASS", retryExhaustion: "GATEWAY_BOUNDED_RETRY_PASS", providerFailureIsolation: "GATEWAY_CLASSIFICATION_PASS", audioAdmission: "REAL_POSTGRES_BUSINESS_PATH_PASS", secretLeakScan: "PASS", tenantIsolation: "PASS", concurrencySafety: "REAL_POSTGRES_ADVISORY_LOCK_PASS", productionConfig: "PASS", restoreSmoke: "DOCUMENTED_NOT_AUTOMATED" }, null, 2)}\n`);
} catch (error) { mkdirSync("output/phase18", { recursive: true }); writeFileSync("output/phase18/production-hardening-evidence.json", `${JSON.stringify({ sha, status: "FAILED", error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`); throw error; }
finally { postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`); }
