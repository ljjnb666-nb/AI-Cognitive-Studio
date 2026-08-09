import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";

const workerProcesses: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  await Promise.all(
    workerProcesses.splice(0).map(async (child) => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "close");
      }
    }),
  );
});

test.skipIf(process.platform === "win32")("exits cleanly after SIGTERM", async () => {
  const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "src/index.ts"], {
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

  child.kill("SIGTERM");
  const [exitCode] = (await once(child, "close")) as [number | null];

  expect(exitCode).toBe(0);
  expect(output).toContain('"event":"worker.shutdown.completed"');
});
