import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const root = process.cwd();
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString("utf8").trim();
const evidence = { sha, startedAt: new Date().toISOString(), status: "FAILED" };
function run(args) {
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], { cwd: root, stdio: "inherit", env: process.env })
    : spawnSync("pnpm", args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`PHASE18_2_COMMAND_FAILED:pnpm ${args.join(" ")}`);
}
function write() { mkdirSync("output/phase18-2", { recursive: true }); writeFileSync("output/phase18-2/release-evidence.json", `${JSON.stringify(evidence, null, 2)}\n`); }
try {
  run(["--filter", "@ai-cognitive/provider-gateway", "exec", "vitest", "run", "tests/phase8b.test.ts", "tests/phase8c.test.ts", "tests/phase9-model-manifest.test.ts"]);
  run(["--filter", "@ai-cognitive/provider-gateway", "exec", "vitest", "run", "tests/gateway-admin.integration.test.ts"]);
  run(["--filter", "@ai-cognitive/web", "exec", "vitest", "run", "--config", "vitest.integration.config.mts", "tests/provider-settings-errors.integration.test.ts", "tests/provider-readiness.integration.test.ts"]);
  run(["--filter", "@ai-cognitive/book-intelligence", "exec", "vitest", "run", "--config", "vitest.integration.config.ts", "tests/phase8c-checkpoint3a-acceptance.integration.test.ts", "tests/principal-provenance.integration.test.ts"]);
  run(["--filter", "@ai-cognitive/worker", "exec", "vitest", "run", "--config", "vitest.integration.config.ts", "tests/phase8c-production-runtime.test.ts"]);
  run(["test:phase18:release"]);
  run(["test:phase18-1:release"]);
  evidence.status = "PASSED";
  evidence.matrix = "M01-M28 repository-equivalent deterministic coverage, including Provider duplicate-conflict safety and Book readiness dependency UX";
} catch (error) { evidence.error = error instanceof Error ? error.message : String(error); throw error; }
finally { evidence.finishedAt = new Date().toISOString(); write(); }
