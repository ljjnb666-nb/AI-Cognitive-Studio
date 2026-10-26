/**
 * Timeout-enforced Windows-only handoff for offline real-stack proof.
 * Only a fixed first-party command is launched; no secret/stderr echo.
 */
import { openSync, closeSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const [stdoutPath, stderrPath] = process.argv.slice(2);
if (process.platform !== "win32" ||
    process.env.ACS_DOCLING_REAL_STACK_E2E !== "1" ||
    !/^[a-f0-9]{40}$/.test(process.env.ACS_DOCLING_VERIFIED_SOURCE_SHA ?? "") ||
    !stdoutPath || !stderrPath || process.argv.length !== 4) {
  console.log("ACS_DOCLING_REAL_STACK_PROOF_WRAPPER=REJECTED");
  process.exit(2);
}
const STAGES = new Set(["ADMISSION", "OFFLINE_MODEL_PROBE", "INFRASTRUCTURE",
  "LINEAGE_SEED", "REAL_QUEUE_MODEL", "EVIDENCE", "REPLAY",
  "REPLAY_VERIFIED", "CLEANUP_WORKER", "CLEANUP_EVENTS",
  "CLEANUP_QUEUE_OBLITERATE", "CLEANUP_QUEUE_CLOSE",
  "CLEANUP_EXECUTOR", "CLEANUP_DATABASE", "CLEANUP_S3",
  "CLEANUP_STORAGE", "CLEANUP_DISCONNECT", "CLEANUP_REDIS_CLIENTS", "CLEANUP_DONE"]);
function emitLastStage() {
  try {
    // Only emit allowlisted labels. Do not emit arbitrary child stdout.
    const data = readFileSync(stdoutPath, "utf8").slice(-100_000);
    const matches = [...data.matchAll(/ACS_DOCLING_REAL_STACK_PROOF_STAGE=([A-Z_]+)/g)];
    const last = matches.at(-1)?.[1];
    if (last && STAGES.has(last)) {
      console.log("ACS_DOCLING_REAL_STACK_PROOF_LAST_STAGE=" + last);
    }
    if (data.includes("ACS_DOCLING_REAL_STACK_MAIN_RESOLVED=PASS")) {
      console.log("ACS_DOCLING_REAL_STACK_PROOF_MAIN_RESOLVED=PASS");
    }
    for (const name of ["SOCKET","CHILD_PROCESS","MESSAGE_PORT","FS_WATCHER","OTHER","REQUESTS"]) {
      const matches = [...data.matchAll(new RegExp(
        "ACS_DOCLING_REAL_STACK_LINGER_" + name + "=([0-9]{1,3})","g"
      ))];
      if (matches.length) console.log("ACS_DOCLING_REAL_STACK_PROOF_LINGER_" +
        name + "=" + matches.at(-1)[1]);
    }
    for (const name of ["STDIO","TEST_SERVICE","OTHER_TCP","UNKNOWN"]) {
      const matches = [...data.matchAll(new RegExp(
        "ACS_DOCLING_REAL_STACK_SOCKET_ORIGIN_" + name + "=([0-9]{1,3})","g"
      ))];
      if (matches.length) console.log("ACS_DOCLING_REAL_STACK_PROOF_SOCKET_ORIGIN_" +
        name + "=" + matches.at(-1)[1]);
    }
    for (const kind of ["PIPE","TCP","OTHER"]) {
      if (data.includes("ACS_DOCLING_REAL_STACK_SOLE_HANDLE_KIND=" + kind)) {
        console.log("ACS_DOCLING_REAL_STACK_PROOF_SOLE_HANDLE_KIND=" + kind);
        break;
      }
    }
    for (const state of ["PASS","NOT_APPLICABLE"]) {
      if (data.includes("ACS_DOCLING_REAL_STACK_ISOLATED_LOCAL_PIPE_UNREF=" + state)) {
        console.log("ACS_DOCLING_REAL_STACK_PROOF_LOCAL_PIPE_UNREF=" + state);
        break;
      }
    }
    for (const name of ["WORKER","EVENTS","QUEUE_OBLITERATE","QUEUE_CLOSE","EXECUTOR","STORAGE","DB_DISCONNECT","REDIS"]) {
      if (data.includes("ACS_DOCLING_REAL_STACK_TEARDOWN_" + name + "=REJECTED")) {
        console.log("ACS_DOCLING_REAL_STACK_PROOF_TEARDOWN_" + name + "=REJECTED");
      }
    }
  } catch {
    console.log("ACS_DOCLING_REAL_STACK_PROOF_STAGE_LOG=UNAVAILABLE");
  }
}
const TIMEOUT_MS = 10 * 60 * 1000;
let out, err;
try {
  out = openSync(stdoutPath, "wx");
  err = openSync(stderrPath, "wx");
} catch {
  console.log("ACS_DOCLING_REAL_STACK_PROOF_OUTPUT=REJECTED");
  process.exit(2);
}
// Launch one Node child directly. The old cmd -> pnpm -> tsx process chain
// could outlive a successfully-resolved proof and retain a source-tree handle.
// The package-local tsx import handles TypeScript/ESM without an intermediary
// shell or pnpm process. The child tree remains bounded by the watchdog.
const child = spawn(process.execPath, [
  "--import", "tsx", "tests/docling-real-stack.proof.ts",
], {
  cwd: resolve(process.cwd(), "apps", "worker"),
  windowsHide: true,
  stdio: ["ignore", out, err],
  env: process.env,
});
closeSync(out);
closeSync(err);
let complete = false;
const timer = setTimeout(() => {
  if (complete) return;
  complete = true;
  // Terminate only the wrapper's child command tree, never other processes.
  const killed = Number.isSafeInteger(child.pid) && child.pid > 0
    ? spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true, timeout: 15_000, stdio: "ignore",
      })
    : null;
  emitLastStage();
  console.log("ACS_DOCLING_REAL_STACK_PROOF_TIMEOUT=REJECTED");
  console.log("ACS_DOCLING_REAL_STACK_PROOF_TREE_TERMINATION=" +
    (killed?.status === 0 ? "CONFIRMED" : "UNVERIFIED"));
  process.exit(2);
}, TIMEOUT_MS);
child.once("error", () => {
  if (complete) return;
  complete = true;
  clearTimeout(timer);
  emitLastStage();
  console.log("ACS_DOCLING_REAL_STACK_PROOF_SPAWN=REJECTED");
  process.exitCode = 2;
});
child.once("close", (code, signal) => {
  if (complete) return;
  complete = true;
  clearTimeout(timer);
  emitLastStage();
  if (code !== 0 || signal) {
    console.log("ACS_DOCLING_REAL_STACK_PROOF_EXIT=REJECTED");
    process.exitCode = 2;
  } else {
    console.log("ACS_DOCLING_REAL_STACK_PROOF_EXIT=PASS");
  }
});
