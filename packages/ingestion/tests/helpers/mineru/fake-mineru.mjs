// TEST-ONLY MinerU CLI double (BOOK-INGESTION-04B-3). Emulates the 04B-0
// VERIFIED 4.0.3 contract surface the executor depends on:
//   server start -> spawns a real killable dummy server process, writes
//                   <MINERU_HOME>/doclib.endpoint.json (v2 pid/server_id/transports)
//   server stop  -> terminates the recorded endpoint pid, exit 0
//   parse <pdf> --tier T --pages N-N --output M --json --force
//                -> behavior selected by MINERU_FAKE_MODE (success | delay |
//                   model_not_ready | server_not_running | crash | no_output |
//                   wrong_path | oversize | empty)
// Modes and timing come from the environment so the executor's own child env
// inheritance carries them; no shell is used anywhere.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const [, , command, ...rest] = process.argv;
const home = process.env.MINERU_HOME;
if (!home) {
  console.error("fake-mineru: MINERU_HOME not set");
  process.exit(9);
}
const endpointPath = join(home, "doclib.endpoint.json");

function readArgs(tokens) {
  const parsed = { positional: [], flags: {} };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.startsWith("--")) {
      const value = index + 1 < tokens.length && !tokens[index + 1].startsWith("--") ? tokens[++index] : true;
      parsed.flags[token.slice(2)] = value;
    } else parsed.positional.push(token);
  }
  return parsed;
}

if (command === "server" && rest[0] === "start") {
  mkdirSync(home, { recursive: true });
  // A REAL killable descendant: the recorded endpoint pid is a dummy process
  // the guarded-kill path can verify and force-kill by recorded identity.
  const dummy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { detached: true, stdio: "ignore", windowsHide: true });
  dummy.unref();
  writeFileSync(endpointPath, JSON.stringify({ version: 2, pid: dummy.pid, server_id: "fake-server-identity", transports: [{ type: "tcp", base_url: "http://127.0.0.1:1", port: 1 }] }));
  console.log("服务已启动(PID " + dummy.pid + ")。");
  process.exit(0);
} else if (command === "server" && rest[0] === "stop") {
  try {
    const endpoint = JSON.parse(readFileSync(endpointPath, "utf8"));
    try { process.kill(endpoint.pid); } catch { /* already gone */ }
  } catch { /* no endpoint */ }
  console.log("服务已停止。");
  process.exit(0);
} else if (command === "parse") {
  runParse();
} else if (command === "--version") {
  console.log("MinerU 版本: 4.0.3-fake");
  process.exit(0);
} else {
  console.error("fake-mineru: unsupported command " + String(command));
  process.exit(9);
}

function runParse() {
  const args = readArgs(rest);
  const mode = process.env.MINERU_FAKE_MODE ?? "success";
  const output = args.flags.output;
  const finish = (body) => {
    if (mode === "delay") {
      const delay = Number(process.env.MINERU_FAKE_DELAY_MS ?? 0);
      setTimeout(() => { process.stdout.write(JSON.stringify(body)); process.exit(0); }, delay);
      return;
    }
    process.stdout.write(JSON.stringify(body));
    process.exit(0);
  };
  if (mode === "model_not_ready") {
    process.stdout.write(JSON.stringify({ error: { type: "engine_error", code: "parse_failed", message: "Model repo MinerU-4_models_onnx is not ready under " + (process.env.MINERU_MODEL_BASE_DIR ?? "?") + "; missing: OCR/paddleocr/fake.onnx", param: null } }));
    process.exit(1);
  }
  if (mode === "server_not_running") {
    process.stdout.write(JSON.stringify({ error: { type: "api_error", code: "server_not_running", message: "本地 mineru 服务未运行。请先运行 'mineru server start'。", param: null } }));
    process.exit(1);
  }
  if (mode === "crash") {
    process.stdout.write("Traceback (most recent call last): fake crash");
    process.exit(7);
  }
  if (mode === "no_output") {
    finish({ parse: { status: "done" }, output: { status: "failed" } });
    return;
  }
  if (mode === "wrong_path") {
    const elsewhere = output + ".elsewhere.md";
    writeFileSync(elsewhere, "misplaced output", "utf8");
    finish({ parse: { status: "done" }, output: { status: "written", path: elsewhere } });
    return;
  }
  // success / delay / oversize / empty all claim a written output.
  mkdirSync(dirname(output), { recursive: true });
  const empty = mode === "empty";
  const oversize = mode === "oversize";
  const text = empty ? "  \n\t \uFEFF" : oversize ? "A".repeat(Number(process.env.MINERU_FAKE_OVERSIZE_BYTES ?? 32 * 1024 * 1024)) : process.env.MINERU_FAKE_TEXT ?? "fake scanned page text";
  writeFileSync(output, text, "utf8");
  finish({ parse: { status: "done", tier: args.flags.tier, page_range: args.flags.pages }, content: null, output: { status: "written", path: output } });
}
