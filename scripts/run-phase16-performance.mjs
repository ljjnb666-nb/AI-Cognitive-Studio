import { spawnSync } from "node:child_process";

const result = process.platform === "win32"
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm --filter @ai-cognitive/performance test"], { stdio: "inherit", shell: false })
  : spawnSync("pnpm", ["--filter", "@ai-cognitive/performance", "test"], { stdio: "inherit", shell: false });
if (result.status !== 0) throw new Error("PHASE16_PERFORMANCE_TEST_FAILED");
