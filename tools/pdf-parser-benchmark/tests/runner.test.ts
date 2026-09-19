import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Runner } from "../src/runner.js";
import { terminateTree, launch, type LaunchedProcess } from "../src/process-launcher.js";

const scratchRoot = join(tmpdir(), "bench-runner-tests");

async function scratch(name: string): Promise<string> {
  const dir = join(scratchRoot, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  await rm(scratchRoot, { recursive: true, force: true });
});

describe("runner safety behavior", () => {
  it("kills the child process tree on timeout and reports treeKilledClean", async () => {
    const dir = await scratch("timeout");
    const runner = new Runner();
    const outcome = await runner.run(
      {
        programId: "node",
        // child spawns a grandchild; tree kill must remove both
        argv: ["-e", 'const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]); setInterval(()=>{}, 1000);'],
        cwd: dir,
        env: {},
      },
      { timeoutMs: 3_000 },
    );
    expect(outcome.timedOut).toBe(true);
    expect(outcome.killedByHarness).toBe(true);
    expect(outcome.treeKilledClean).toBe(true);
    expect(existsSync(dir)).toBe(true); // harness cleans temp; runner does not delete
    await rm(dir, { recursive: true, force: true });
  });

  it("enforces the output-dir size limit", async () => {
    const dir = await scratch("output-limit");
    const runner = new Runner();
    const outcome = await runner.run(
      {
        programId: "node",
        argv: [
          "-e",
          'const fs = require("node:fs"); let i = 0; const write = () => { fs.writeFileSync(`blob-${i++}.bin`, Buffer.alloc(1024 * 1024, 1)); setTimeout(write, 50); }; write();',
        ],
        cwd: dir,
        env: {},
      },
      { timeoutMs: 60_000, maxOutputDirBytes: 4 * 1024 * 1024 },
    );
    expect(outcome.outputLimitExceeded).toBe(true);
    expect(outcome.killedByHarness).toBe(true);
  });

  it("terminates an externally launched tree on demand", async () => {
    const dir = await scratch("terminate");
    const child: LaunchedProcess = launch("node", ["-e", "setInterval(()=>{}, 1000)"], { cwd: dir });
    const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await terminateTree(child.pid);
    await exited;
  });

  it("captures exit codes from failing children", async () => {
    const dir = await scratch("exit-code");
    const outcome = await new Runner().run(
      { programId: "node", argv: ["-e", "process.exit(7)"], cwd: dir, env: {} },
      { timeoutMs: 30_000 },
    );
    expect(outcome.exitCode).toBe(7);
    expect(outcome.timedOut).toBe(false);
  });
});
