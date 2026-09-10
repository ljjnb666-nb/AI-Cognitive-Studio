import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const root = process.cwd();
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString("utf8").trim();
const expected = process.env.PHASE18_1_GIT_SHA;
if (expected && expected !== sha) throw new Error("PHASE18_1_EXACT_HEAD_MISMATCH");
const evidence = { sha, artifactSha: expected ?? sha, startedAt: new Date().toISOString(), status: "FAILED" };
function run(args) {
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], { cwd: root, stdio: "inherit", env: process.env })
    : spawnSync("pnpm", args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`PHASE18_1_COMMAND_FAILED:pnpm ${args.join(" ")}`);
}
function write() { mkdirSync("output/phase18-1", { recursive: true }); writeFileSync("output/phase18-1/release-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`); }
try {
  run(["test:phase18:release"]);
  run(["--filter", "@ai-cognitive/ingestion", "exec", "vitest", "run", "--config", "vitest.integration.config.ts", "tests/complete-upload.integration.test.ts"]);
  run(["--filter", "@ai-cognitive/worker", "exec", "vitest", "run", "--config", "vitest.integration.config.ts", "tests/phase18-1-processing-heartbeat.integration.test.ts"]);
  run(["--filter", "@ai-cognitive/worker", "exec", "vitest", "run", "--config", "vitest.integration.config.ts", "tests/worker-lifecycle.integration.test.ts"]);
  run(["--filter", "@ai-cognitive/web", "exec", "vitest", "run", "--config", "vitest.integration.config.mts", "tests/phase18-1-processing-state.integration.test.ts"]);
  run(["test:phase6:e2e"]);
  evidence.status = "PASSED"; evidence.migrations = "PHASE18_DEPLOY_TWICE_PASSED"; evidence.ingestionRecovery = "REAL_POSTGRES_CONCURRENT_IDEMPOTENCE_PASS"; evidence.workerHeartbeat = "TTL_SAFE_METADATA_PASS"; evidence.browserFlow = "PHASE6_REAL_WORKER_FLOW_PASS";
} catch (error) { evidence.error = error instanceof Error ? error.message : String(error); throw error; }
finally { evidence.finishedAt = new Date().toISOString(); write(); }
