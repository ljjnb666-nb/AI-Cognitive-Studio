import { cpSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

// The test owns the single fixture -> evaluator -> assertions -> artifact path.
const command = ["--filter", "@ai-cognitive/podcast-generation", "exec", "vitest", "run", "tests/phase15-quality.test.ts"];
const result = process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${command.join(" ")}`], { stdio: "inherit", shell: false })
  : spawnSync("pnpm", command, { stdio: "inherit", shell: false });
if (result.status !== 0) throw new Error("PHASE15_QUALITY_TEST_FAILED");
rmSync("output/phase15", { recursive: true, force: true });
cpSync("packages/podcast-generation/output/phase15", "output/phase15", { recursive: true });
