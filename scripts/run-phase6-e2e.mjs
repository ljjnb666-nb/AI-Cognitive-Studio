import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const database = "ai_cognitive_studio_phase6_test";
const root = process.cwd();
const require = createRequire(join(root, "apps", "web", "package.json"));
const tsxCli = require.resolve("tsx/cli");
const postgresPort = process.env.POSTGRES_HOST_PORT ?? "5433";
const redisPort = process.env.REDIS_HOST_PORT ?? "6379";
const minioPort = process.env.S3_HOST_PORT ?? "9000";
const providerKeyring = Buffer.alloc(32, 6).toString("base64");
const providerManifest = JSON.stringify({ providers: [
  { providerKey: "phase6-analysis", displayName: "Phase 6 analysis", protocol: "TEST", adapterVersion: "phase6", models: [{ modelId: "fixture", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }, { modelId: "embedding", families: ["EMBEDDING"], confidence: "VERIFIED", embeddingDimensions: 4 }] },
  { providerKey: "deterministic-test", displayName: "Phase 6 embedding fixture", protocol: "TEST", adapterVersion: "phase6", models: [{ modelId: "deterministic-vector-v1", families: ["EMBEDDING"], confidence: "VERIFIED", embeddingDimensions: 4 }] },
  { providerKey: "phase6-podcast", displayName: "Phase 6 podcast", protocol: "TEST", adapterVersion: "phase6", models: [{ modelId: "fixture", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }] },
  { providerKey: "phase6-wav", displayName: "Phase 6 audio", protocol: "TEST", adapterVersion: "phase6", models: [{ modelId: "fixture", families: ["SPEECH"], confidence: "VERIFIED", speechFormats: ["wav"] }] },
  { providerKey: "phase6-video", displayName: "Phase 6 video", protocol: "TEST", adapterVersion: "phase6", models: [{ modelId: "fixture", families: ["TEXT_GENERATION"], confidence: "VERIFIED", structuredOutput: "STRICT_JSON_SCHEMA" }] },
  { providerKey: "phase6-video-wav", displayName: "Phase 6 video audio", protocol: "TEST", adapterVersion: "phase6", models: [{ modelId: "fixture", families: ["SPEECH"], confidence: "VERIFIED", speechFormats: ["wav"] }] },
] });
const environment = {
  ...process.env,
  NODE_ENV: "test",
  BETTER_AUTH_SECRET: "phase6-test-secret-must-be-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3001",
  PHASE6_BROWSER_ACCEPTANCE: "true",
  DATABASE_URL: `postgresql://app:app@localhost:${postgresPort}/${database}?schema=public`,
  DATABASE_URL_TEST: `postgresql://app:app@localhost:${postgresPort}/${database}?schema=public`,
  REDIS_URL: `redis://localhost:${redisPort}/15`,
  S3_ENDPOINT: `http://localhost:${minioPort}`,
  S3_PUBLIC_ENDPOINT: `http://localhost:${minioPort}`,
  S3_REGION: "us-east-1",
  S3_BUCKET: "ai-cognitive-studio-phase6-test",
  S3_ACCESS_KEY: "local-development-only",
  S3_SECRET_KEY: "local-development-only",
  S3_FORCE_PATH_STYLE: "true",
  WEB_DEV_BOOTSTRAP_IDENTITY: "true",
  WEB_DEV_BOOTSTRAP_EMAIL: "phase6-browser@ai-cognitive-studio.test",
  WEB_TEST_HARNESS_TOKEN: randomUUID(),
  WEB_TEST_HARNESS_EMAIL: "phase6-browser@ai-cognitive-studio.test",
  PHASE6_BULLMQ_PREFIX: `phase6-${randomUUID()}`,
  SOURCE_PARSE_TIMEOUT_MS: "1000",
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
  PROVIDER_GATEWAY_KEYRING: JSON.stringify({ activeVersion: "phase6", keys: { phase6: providerKeyring } }),
  PROVIDER_GATEWAY_MODEL_MANIFEST: providerManifest,
};

function command(program, args) {
  const result = process.platform === "win32" && program === "pnpm"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], { cwd: root, env: environment, stdio: "inherit", shell: false })
    : spawnSync(program, args, { cwd: root, env: environment, stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error(`PHASE6_COMMAND_FAILED:${program}`);
}
function postgres(sql) {
  const container = process.env.PHASE6_POSTGRES_CONTAINER;
  if (container) { execFileSync("docker", ["exec", "-i", container, "psql", "-U", "app", "-d", "postgres", "-c", sql], { cwd: root, env: environment, stdio: "inherit" }); return; }
  try { execFileSync("psql", ["-h", "localhost", "-p", postgresPort, "-U", "app", "-d", "postgres", "-c", sql], { cwd: root, env: { ...environment, PGPASSWORD: "app" }, stdio: "inherit" }); }
  catch { command("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "app", "-d", "postgres", "-c", sql]); }
}
let worker;
let workerTermination;
let stopWorkerPromise;
async function stopWorker() {
  if (!worker) return;
  return stopWorkerPromise ??= (async () => {
    if (worker.exitCode !== null || worker.signalCode !== null) return;
    worker.send({ type: "PHASE6_RUNTIME_SHUTDOWN" });
    const exited = await Promise.race([workerTermination, new Promise((resolve) => setTimeout(() => resolve(undefined), 5_000))]);
    if (exited) return;
    worker.kill();
    const forced = await Promise.race([workerTermination, new Promise((resolve) => setTimeout(() => resolve(undefined), 5_000))]);
    if (!forced) throw new Error("PHASE6_RUNTIME_TERMINATION_NOT_CONFIRMED");
    throw new Error("PHASE6_RUNTIME_GRACEFUL_SHUTDOWN_TIMEOUT");
  })();
}
function minio(commandLine) {
  const container = process.env.PHASE6_MINIO_CONTAINER;
  if (container) { execFileSync("docker", ["exec", container, "sh", "-c", commandLine], { cwd: root, env: environment, stdio: "inherit" }); return; }
  command("docker", ["compose", "exec", "-T", "minio", "sh", "-c", commandLine]);
}
try {
  postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
  postgres(`CREATE DATABASE ${database};`);
  minio(`mc alias set phase6 http://localhost:9000 ${environment.S3_ACCESS_KEY} ${environment.S3_SECRET_KEY} && (mc rb --force phase6/${environment.S3_BUCKET} || true) && mc mb phase6/${environment.S3_BUCKET}`);
  command("pnpm", ["db:migrate:deploy"]);
  command("pnpm", ["--filter", "@ai-cognitive/web", "build"]);
  // This browser pass deliberately has no worker runtime. It proves that a
  // durable upload becomes an honest, recoverable degraded state instead of
  // remaining an infinite queued badge.
  command("pnpm", ["--filter", "@ai-cognitive/web", "exec", "playwright", "test", "--config", "playwright.phase6.config.ts", "tests/phase6/processing-recovery.spec.ts"]);
  const readyFile = join(root, "output", "playwright", "phase6-runtime.ready");
  await rm(readyFile, { force: true });
  worker = spawn(process.execPath, [tsxCli, join(root, "apps", "web", "tests", "phase6", "runtime.ts")], { cwd: root, env: { ...environment, PHASE6_RUNTIME_READY_FILE: readyFile }, stdio: ["inherit", "inherit", "inherit", "ipc"], shell: false });
  workerTermination = new Promise((resolve) => { worker.once("exit", (code, signal) => resolve({ code, signal })); worker.once("error", (error) => resolve({ error })); });
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
  if (process.env.PHASE6_KEEP_ARTIFACTS !== "true") {
    try { minio(`mc alias set phase6 http://localhost:9000 ${environment.S3_ACCESS_KEY} ${environment.S3_SECRET_KEY} && (mc rb --force phase6/${environment.S3_BUCKET} || true)`); } catch { /* isolated cleanup is best effort */ }
    postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
  }
}
