import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBounded } from "../../src/mineru/mineru-process.js";

/**
 * RF01 P1-04 teeth for spawnBounded's hard deadline:
 *  1. a hung child is terminated at the deadline and the caller returns within
 *     the bounded window with an HONEST terminateConfirmed disposition;
 *  2. when the child has already exited but a surviving detached descendant
 *     holds the stdio pipes open (the classic never-firing `close`), the
 *     caller STILL returns — bounded drain — and the disposition says the
 *     invocation timed out without a confirmed termination.
 * No test asserts implementation internals; only observable bounded behavior.
 */

const tempRoots: string[] = [];
const spawnedPids: number[] = [];

function newTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mineru-proc-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const pid of spawnedPids) {
    try { spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ }
  }
  spawnedPids.length = 0;
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

describe("spawnBounded hard deadline (RF01 P1-04)", () => {
  it("terminates a hung child at the deadline and resolves within the bounded window", async () => {
    const started = Date.now();
    const result = await spawnBounded(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      env: process.env,
      timeoutMs: 400,
      terminationGraceMs: 700,
      maxOutputBytes: 65_536,
    });
    const elapsed = Date.now() - started;
    expect(result.timedOut).toBe(true);
    expect(result.treeTerminationConfirmed).toBe(true);
    // deadline + grace + bounded escalation — never an infinite wait.
    expect(elapsed).toBeLessThan(400 + 700 + 2_500);
  }, 20_000);

  it("treeTerminationConfirmed is NEVER true when the owned tree-termination operation fails (RF02 P2)", async () => {
    // The owned termination seam FAILS (simulates taskkill refusing/failing
    // while a descendant survives): the disposition must not claim tree
    // termination, no matter what the direct child does.
    const result = await spawnBounded(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      env: process.env,
      timeoutMs: 300,
      terminationGraceMs: 300,
      maxOutputBytes: 65_536,
      terminateProcessTree: async () => false,
    });
    expect(result.timedOut).toBe(true);
    expect(result.treeTerminationConfirmed).toBe(false);
    expect(result.directChildExitObserved).toBe(false);
    expect(result.code).toBeNull();
  }, 20_000);

  it("treeTerminationConfirmed is true only with owned-termination success AND direct child exit (RF02 P2)", async () => {
    const result = await spawnBounded(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      env: process.env,
      timeoutMs: 300,
      terminationGraceMs: 1_000,
      maxOutputBytes: 65_536,
    });
    expect(result.timedOut).toBe(true);
    // The REAL owned termination (taskkill /T /F) reported success and the
    // direct child exited: the confirmed disposition is honest here.
    expect(result.treeTerminationConfirmed).toBe(true);
    expect(result.directChildExitObserved).toBe(true);
  }, 20_000);

  it("returns bounded when a surviving detached descendant holds the stdio pipes (close would never fire)", async () => {
    const dir = newTempDir();
    const pidFile = join(dir, "grandchild.pid");
    // The child exits after 120ms (BEFORE the 900ms deadline) and leaves a
    // detached descendant inheriting its stdio pipes: the legacy close-only
    // wait could NEVER fire and the caller would pend forever. The repaired
    // implementation resolves at child exit with a bounded drain and an HONEST
    // disposition — no termination was initiated, nothing was "confirmed".
    const childScript = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
      fs.writeFileSync(process.env.PID_FILE, String(grandchild.pid));
      grandchild.unref();
      setTimeout(() => process.exit(0), 120);
    `;
    const started = Date.now();
    const result = await spawnBounded(process.execPath, ["-e", childScript], {
      env: { ...process.env, PID_FILE: pidFile },
      timeoutMs: 900,
      terminationGraceMs: 500,
      maxOutputBytes: 65_536,
    });
    // Bounded return long before the vitest gate could have caught a hang.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.timedOut).toBe(false);
    // The child itself exited on its own BEFORE termination: our kill did
    // nothing, and the disposition must NOT claim a confirmed termination.
    expect(result.code).toBe(0);
    expect(result.treeTerminationConfirmed).toBe(false);
    expect(existsSync(pidFile)).toBe(true);
    spawnedPids.push(Number(readFileSync(pidFile, "utf8")));
  }, 20_000);
});
