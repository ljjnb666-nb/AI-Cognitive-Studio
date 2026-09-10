import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { resolveBookWorkerCapability, resolvePodcastRuntimeAdapter } from "../src/runtime.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workerProcesses: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  await Promise.all(
    workerProcesses.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await once(child, "close");
      }
    }),
  );
});

test("exits cleanly after the platform termination signal", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  workerProcesses.push(child);

  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  await expect
    .poll(() => output.includes('"event":"worker.started"'), { timeout: 15_000 })
    .toBe(true);

  child.kill(process.platform === "win32" ? "SIGINT" : "SIGTERM");
  const [exitCode] = (await once(child, "close")) as [number | null];

  if (process.platform === "win32") expect(child.signalCode).toBe("SIGINT");
  else {
    expect(exitCode).toBe(0);
    expect(output).toContain('"event":"worker.shutdown.completed"');
  }
});

test("podcast runtime configuration is disabled when absent and fails explicitly when unsupported", () => {
  expect(resolvePodcastRuntimeAdapter({})).toBeUndefined();
  expect(() => resolvePodcastRuntimeAdapter({ PODCAST_GENERATION_PROVIDER: "unsupported-vendor" })).toThrow("PODCAST_GENERATION_PROVIDER_UNSUPPORTED:unsupported-vendor");
});

test("book worker capability reuses Gateway keyring and catalog semantics", () => {
  const path = join(mkdtempSync(join(tmpdir(), "acs-keyring-")), "keyring.json"), keyring = JSON.stringify({ activeVersion: "v1", keys: { v1: Buffer.alloc(32).toString("base64") } });
  writeFileSync(path, keyring);
  expect(resolveBookWorkerCapability({ NODE_ENV: "development", PROVIDER_GATEWAY_LOCAL_KEYRING_PATH: path })).toBe(true);
  expect(resolveBookWorkerCapability({ NODE_ENV: "production", PROVIDER_GATEWAY_KEYRING: keyring })).toBe(true);
  expect(resolveBookWorkerCapability({ NODE_ENV: "production" })).toBe(false);
  expect(resolveBookWorkerCapability({ NODE_ENV: "production", PROVIDER_GATEWAY_KEYRING: keyring, PROVIDER_GATEWAY_MODEL_MANIFEST: JSON.stringify({ providers: [] }) })).toBe(true);
});
