import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const database = "ai_cognitive_studio_phase6_test";
const root = process.cwd();
const postgresPort = process.env.POSTGRES_HOST_PORT ?? "5433";
const environment = {
  ...process.env,
  NODE_ENV: "test",
  PHASE6_BROWSER_ACCEPTANCE: "true",
  DATABASE_URL: `postgresql://app:app@localhost:${postgresPort}/${database}?schema=public`,
  DATABASE_URL_TEST: `postgresql://app:app@localhost:${postgresPort}/${database}?schema=public`,
  REDIS_URL: "redis://localhost:6379/15",
  S3_ENDPOINT: "http://localhost:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "ai-cognitive-studio-phase6-test",
  S3_ACCESS_KEY: "local-development-only",
  S3_SECRET_KEY: "local-development-only",
  S3_FORCE_PATH_STYLE: "true",
  WEB_DEV_BOOTSTRAP_IDENTITY: "true",
  WEB_DEV_BOOTSTRAP_EMAIL: "phase6-browser@ai-cognitive-studio.test",
  WEB_TEST_HARNESS_TOKEN: randomUUID(),
  WEB_TEST_HARNESS_EMAIL: "phase6-browser@ai-cognitive-studio.test",
  BOOK_ANALYSIS_PROVIDER: "phase6-analysis",
  BOOK_ANALYSIS_MODEL: "fixture",
  PODCAST_GENERATION_PROVIDER: "phase6-podcast",
  PODCAST_GENERATION_MODEL: "fixture",
  PODCAST_GENERATION_MODEL_VERSION: "1",
  AUDIO_GENERATION_PROVIDER: "phase6-wav",
  AUDIO_GENERATION_MODEL: "fixture",
  AUDIO_GENERATION_MODEL_VERSION: "1",
  SHORT_VIDEO_GENERATION_PROVIDER: "phase6-video",
  SHORT_VIDEO_GENERATION_MODEL: "fixture",
  SHORT_VIDEO_GENERATION_MODEL_VERSION: "1",
};

function command(program, args) {
  const result = process.platform === "win32" && program === "pnpm"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], { cwd: root, env: environment, stdio: "inherit", shell: false })
    : spawnSync(program, args, { cwd: root, env: environment, stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error(`PHASE6_COMMAND_FAILED:${program}`);
}
function postgres(sql) {
  try { execFileSync("psql", ["-h", "localhost", "-p", postgresPort, "-U", "app", "-d", "postgres", "-c", sql], { cwd: root, env: { ...environment, PGPASSWORD: "app" }, stdio: "inherit" }); }
  catch { command("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "app", "-d", "postgres", "-c", sql]); }
}
function redis(argumentsList) {
  try { execFileSync("redis-cli", argumentsList, { cwd: root, env: environment, stdio: "inherit" }); }
  catch { command("docker", ["compose", "exec", "-T", "redis", "redis-cli", ...argumentsList]); }
}

let worker;
async function stopWorker() {
  if (!worker || worker.exitCode !== null) return;
  const exited = once(worker, "exit");
  worker.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
}
function minio(commandLine) {
  command("docker", ["compose", "exec", "-T", "minio", "sh", "-c", commandLine]);
}
try {
  postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
  postgres(`CREATE DATABASE ${database};`);
  redis(["-n", "15", "FLUSHDB"]);
  minio(`mc alias set phase6 http://localhost:9000 ${environment.S3_ACCESS_KEY} ${environment.S3_SECRET_KEY} && (mc rb --force phase6/${environment.S3_BUCKET} || true) && mc mb phase6/${environment.S3_BUCKET}`);
  command("pnpm", ["db:migrate:deploy"]);
  command("pnpm", ["--filter", "@ai-cognitive/web", "build"]);
  const readyFile = join(root, "output", "playwright", "phase6-runtime.ready");
  await rm(readyFile, { force: true });
  worker = spawn(process.execPath, [join(root, "node_modules", ".pnpm", "tsx@4.23.11", "node_modules", "tsx", "dist", "cli.mjs"), join(root, "apps", "web", "tests", "phase6", "runtime.ts")], { cwd: root, env: { ...environment, PHASE6_RUNTIME_READY_FILE: readyFile }, stdio: "inherit", shell: false });
  for (let attempt = 0; attempt < 100 && !existsSync(readyFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!existsSync(readyFile)) throw new Error("PHASE6_RUNTIME_START_TIMEOUT");
  command("pnpm", ["--filter", "@ai-cognitive/web", "exec", "playwright", "test", "--config", "playwright.phase6.config.ts"]);
} catch (error) {
  try {
    const sql = "SELECT \"type\", \"status\", \"progress\", \"error\" FROM \"Job\" ORDER BY \"createdAt\"; SELECT \"status\", \"stage\", \"errorCode\" FROM \"PodcastGenerationRun\" ORDER BY \"createdAt\"; SELECT \"status\", \"stage\", \"errorCode\" FROM \"ShortVideoGenerationRun\" ORDER BY \"createdAt\"; SELECT count(*) AS \"currentBookIntelligence\" FROM \"CurrentBookIntelligence\"; SELECT count(*) AS \"podcastAudioArtifacts\" FROM \"PodcastAudioRevision\"; SELECT count(*) AS \"shortVideoArtifacts\" FROM \"ShortVideoRevision\"; SELECT \"topic\", \"dispatchedAt\" IS NOT NULL AS dispatched FROM \"OutboxEvent\" ORDER BY \"createdAt\";";
    let snapshot;
    try {
      snapshot = execFileSync("psql", ["-h", "localhost", "-p", postgresPort, "-U", "app", "-d", database, "-c", sql], { cwd: root, env: { ...environment, PGPASSWORD: "app" }, encoding: "utf8" });
    } catch {
      snapshot = execFileSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "app", "-d", database, "-c", sql], { cwd: root, encoding: "utf8" });
    }
    const diagnosticsDirectory = join(root, "output", "playwright", "phase6");
    await mkdir(diagnosticsDirectory, { recursive: true });
    await writeFile(join(diagnosticsDirectory, "failure-snapshot.txt"), snapshot, "utf8");
    process.stderr.write(snapshot);
  } catch { /* diagnostics are best-effort and never contain source/media payloads */ }
  throw error;
} finally {
  await stopWorker();
  try { redis(["-n", "15", "FLUSHDB"]); } catch { /* isolated cleanup is best effort */ }
  try { minio(`mc alias set phase6 http://localhost:9000 ${environment.S3_ACCESS_KEY} ${environment.S3_SECRET_KEY} && (mc rb --force phase6/${environment.S3_BUCKET} || true)`); } catch { /* isolated cleanup is best effort */ }
  postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
}
