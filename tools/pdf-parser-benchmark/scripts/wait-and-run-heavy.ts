import { preflight, runParser } from "../src/harness.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPORTS_ROOT } from "../src/filesystem-guard.js";

/**
 * Waits for a natural RAM window (no user processes are touched), then runs
 * the heavy-parser smoke subset: docling and mineru flash/basic on the most
 * diagnostic fixtures. Every attempt is logged whether it ran or waited.
 */
const RAM_GATE_GB = 2.5;
const POLL_MS = 3 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const log: string[] = [];
function note(line: string) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  log.push(stamped);
}

async function ram(): Promise<number> {
  return (await preflight(0)).ramAvailableGb;
}

async function main() {
  let doclingDone = false;
  let mineruDone = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !(doclingDone && mineruDone); attempt++) {
    const available = await ram();
    note(`attempt ${attempt}: RAM available ${available.toFixed(2)} GB (gate ${RAM_GATE_GB})`);
    if (available < RAM_GATE_GB) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      continue;
    }

    if (!doclingDone) {
      for (const fixture of ["F1-native-cn", "F3-scanned-cn", "F4-textbook-complex"]) {
        const outcome = await runParser("docling", "local", fixture, { cold: true, preflightRetryMs: 5_000 });
        note(`docling ${fixture}: ${outcome.status} wall=${outcome.result?.performance.wallTimeMs ?? "n/a"} rss=${outcome.result?.performance.peakRssMb ?? "n/a"}`);
        if (outcome.status === "STOPPED_C_DRIVE_PRESSURE") {
          note("C_DRIVE_PRESSURE — aborting remaining heavy runs");
          await flush();
          return;
        }
      }
      doclingDone = true;
    }

    if (!mineruDone && (await ram()) >= RAM_GATE_GB) {
      for (const tier of ["flash", "basic"] as const) {
        const outcome = await runParser("mineru", tier, "F1-native-cn", { cold: true, preflightRetryMs: 5_000 });
        note(`mineru-${tier} F1: ${outcome.status} wall=${outcome.result?.performance.wallTimeMs ?? "n/a"} rss=${outcome.result?.performance.peakRssMb ?? "n/a"}`);
        if (outcome.status === "STOPPED_C_DRIVE_PRESSURE") {
          note("C_DRIVE_PRESSURE — aborting remaining heavy runs");
          await flush();
          return;
        }
      }
      mineruDone = true;
    }
  }
  note(`finished: doclingDone=${doclingDone} mineruDone=${mineruDone}`);
  await flush();
}

async function flush() {
  await mkdir(REPORTS_ROOT, { recursive: true });
  await writeFile(join(REPORTS_ROOT, "heavy-wait.log"), log.join("\n"), "utf8");
}

main()
  .catch((error) => note(`FATAL ${error}`))
  .finally(() => flush());
