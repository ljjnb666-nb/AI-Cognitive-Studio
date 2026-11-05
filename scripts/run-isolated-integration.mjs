import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

// Global reconciliation tests must never scan an earlier interrupted run's rows.
// Keep failed databases for diagnosis; only drop the database created by this run.
if (process.env.NODE_ENV === "production") throw new Error("INTEGRATION_TESTS_REFUSE_PRODUCTION");
const source = new URL(process.env.DATABASE_URL_TEST ?? "postgresql://app:app@localhost:5432/ai_cognitive_studio_test?schema=public");
if (!/(?:^|_)test$/i.test(source.pathname.slice(1))) throw new Error("DATABASE_URL_TEST_MUST_TARGET_TEST_DATABASE");
const database = `acs_integration_${randomBytes(8).toString("hex")}_test`;
const adminUrl = new URL(source); adminUrl.pathname = "/postgres";
const testUrl = new URL(source); testUrl.pathname = `/${database}`;
const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const { PrismaClient } = require("@prisma/client");
const admin = new PrismaClient({ datasources: { db: { url: adminUrl.href } } });
const environment = { ...process.env, NODE_ENV: "test", DATABASE_URL: testUrl.href, DATABASE_URL_TEST: testUrl.href };
const report = { database, status: "INCOMPLETE", retained: true };
let created = false;
function run(args) {
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], { env: environment, stdio: "inherit", windowsHide: true })
    : spawnSync("pnpm", args, { env: environment, stdio: "inherit" });
  if (result.error || result.status !== 0) throw new Error(`INTEGRATION_COMMAND_FAILED:${args[0]}`);
}
try {
  // The identifier is generated above from hex, never from a caller-provided name.
  await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
  created = true;
  console.log(`Isolated integration database: ${database}`);
  run(["db:migrate:deploy"]);
  run(["test:integration:suites"]);
  await admin.$executeRawUnsafe(`DROP DATABASE "${database}"`);
  report.retained = false;
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.retained = created;
  report.error = error instanceof Error ? error.message.split("\n")[0] : "UNKNOWN";
  console.error(`Integration failed; diagnostic database retained: ${created ? database : "none"}`);
  process.exitCode = 1;
} finally {
  await admin.$disconnect();
  await mkdir("output/integration", { recursive: true });
  await writeFile(`output/integration/${database}.json`, JSON.stringify(report, null, 2));
}
