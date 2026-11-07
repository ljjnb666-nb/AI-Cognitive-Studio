import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

// All state is disposable and belongs to this invocation; no host ports or existing services are used.
const image = process.env.ACS_IMAGE;
if (!image) throw new Error("ACS_IMAGE_REQUIRED");
const prefix = `acs-smoke-${randomBytes(6).toString("hex")}`;
const directory = resolve("output", "container-smoke", prefix);
await mkdir(directory, { recursive: true });
const envPath = resolve(directory, "runtime.env");
const password = randomBytes(32).toString("hex");
const names = [];
let networkCreated = false;
const docker = args => {
  try {
    return execFileSync("docker", args, { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    // The default execFileSync error only names the command. Preserve a small,
    // bounded diagnostic from Docker's stderr so registry/daemon/image issues
    // are distinguishable, without printing env-file contents or auth values.
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String(error.stderr ?? "").trim().slice(0, 1600) : "";
    const exitCode = error && typeof error === "object" && "status" in error
      ? String(error.status ?? "unknown") : "unknown";
    const operation = args[0] === "run" ? "run" : args[0] ?? "unknown";
    throw new Error(`CONTAINER_DOCKER_${operation.toUpperCase()}_FAILED:exit=${exitCode}${stderr ? ": " + stderr : ""}`);
  }
};
const logs = name => { const result = spawnSync("docker", ["logs", name], { encoding: "utf8", timeout: 10_000 }); if (result.status !== 0) throw new Error("CONTAINER_LOG_READ_FAILED"); return result.stdout + result.stderr; };
const delay = () => new Promise(resolve => setTimeout(resolve, 500));
async function until(probe, label) {
  for (let i = 0; i < 100; i++) { try { if (probe()) return; } catch {} await delay(); }
  throw new Error(`CONTAINER_SMOKE_TIMEOUT:${label}`);
}
function start(role, args) {
  const name = `${prefix}-${role}`;
  docker(["run", "-d", "--name", name, "--network", prefix, "--network-alias", role, ...args]);
  names.push(name);
  return name;
}
const report = { image, startedAt: new Date().toISOString(), checks: {} };
try {
  const environment = {
    NODE_ENV: "production", POSTGRES_USER: "app", POSTGRES_PASSWORD: password, POSTGRES_DB: "smoke",
    MINIO_ROOT_USER: "acs-smoke", MINIO_ROOT_PASSWORD: password,
    DATABASE_URL: `postgresql://app:${password}@postgres:5432/smoke?schema=public`, REDIS_URL: "redis://redis:6379",
    S3_ENDPOINT: "http://minio:9000", S3_REGION: "us-east-1", S3_BUCKET: "acs-smoke", S3_ACCESS_KEY: "acs-smoke", S3_SECRET_KEY: password, S3_FORCE_PATH_STYLE: "true",
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"), BETTER_AUTH_URL: "https://smoke.invalid", BETTER_AUTH_TRUSTED_ORIGINS: "https://smoke.invalid",
    PROVIDER_GATEWAY_KEYRING: JSON.stringify({ activeVersion: "v1", keys: { v1: randomBytes(32).toString("base64") } }),
  };
  await writeFile(envPath, Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
  docker(["network", "create", prefix]); networkCreated = true;
  // Fresh hosted runners may not have the service images cached. Pull absent
  // images explicitly so registry failures produce a meaningful diagnostic,
  // with one bounded retry for transient transport errors only.
  for (const serviceImage of ["postgres:17-alpine", "redis:7-alpine", "ghcr.io/ljjnb666-nb/acs-ci-minio:RELEASE.2025-04-22T22-12-26Z@sha256:3f97c5651cb6662b880c787a232b6b34fec8d8922e08d6617b25d241a21164bb"]) {
    try { docker(["image", "inspect", serviceImage]); continue; } catch {}
    let pullError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { docker(["pull", serviceImage]); pullError = null; break; }
      catch (error) {
        pullError = error;
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1_500));
      }
    }
    if (pullError) throw pullError;
  }
  const postgres = start("postgres", ["--env-file", envPath, "postgres:17-alpine"]);
  start("redis", ["redis:7-alpine", "redis-server", "--save", "", "--appendonly", "no"]);
  const minio = start("minio", ["--env-file", envPath, "ghcr.io/ljjnb666-nb/acs-ci-minio:RELEASE.2025-04-22T22-12-26Z@sha256:3f97c5651cb6662b880c787a232b6b34fec8d8922e08d6617b25d241a21164bb", "server", "/data"]);
  await until(() => docker(["exec", postgres, "pg_isready", "-U", "app", "-d", "smoke"]).includes("accepting connections"), "postgres");
  await until(() => { docker(["exec", minio, "sh", "-c", 'mc alias set smoke http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb --ignore-existing smoke/acs-smoke']); return true; }, "minio");
  await writeFile(resolve(directory, "migration.log"), docker(["run", "--rm", "--network", prefix, "--env-file", envPath, image, "pnpm", "db:migrate:deploy"]));
  report.checks.migrations = "PASS";
  const common = ["--init", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--env-file", envPath];
  const web = start("web", [...common, "--env", "DEBUG=next:start-server", image]);
  const worker = start("worker", [...common, image, "node", "--import", "tsx", "apps/worker/src/index.ts"]);
  const readiness = 'fetch("http://127.0.0.1:3001/api/readiness",{signal:AbortSignal.timeout(4000)}).then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(1))';
  let readinessBody;
  await until(() => { readinessBody = docker(["exec", web, "node", "-e", readiness]); return true; }, "web-readiness");
  report.checks.readiness = JSON.parse(readinessBody);
  // Exercise the compiled production handlers, not only the readiness endpoint.
  const privateDownloads = ['/api/account/export', '/api/studio/sources/nonexistent/download'];
  const authProbe = `for (const path of ${JSON.stringify(privateDownloads)}) {
    const response = await fetch('http://127.0.0.1:3001' + path, { signal: AbortSignal.timeout(4000), redirect: 'manual' });
    if (response.status !== 401 || !response.headers.get('cache-control')?.includes('no-store')) {
      throw new Error('PRIVATE_DOWNLOAD_AUTH_FAILED:' + path + ':' + response.status);
    }
  }`;
  docker(["exec", web, "node", "--input-type=module", "-e", authProbe]);
  report.checks.privateDownloadAuthentication = "PASS";
  await until(() => logs(worker).includes('"worker.started"'), "worker-start");
  report.checks.nonRoot = docker(["exec", web, "id", "-u"]) === "1000";
  if (!report.checks.nonRoot) throw new Error("CONTAINER_SMOKE_ROOT_USER");
  docker(["stop", "--time", "30", worker]);
  const workerLog = logs(worker);
  await writeFile(resolve(directory, "worker.log"), workerLog);
  if (!workerLog.includes('"worker.shutdown.completed"') || docker(["inspect", "--format", "{{.State.ExitCode}}", worker]) !== "0") throw new Error("CONTAINER_SMOKE_SHUTDOWN_FAILED");
  report.checks.workerGracefulShutdown = "PASS";
  docker(["stop", "--time", "30", web]);
  await writeFile(resolve(directory, "web.log"), logs(web));
  // Next 16 deliberately exits 143 after completing SIGTERM cleanup. Require its completion marker as well.
  report.checks.webExitCode = docker(["inspect", "--format", "{{.State.ExitCode}}", web]);
  if (report.checks.webExitCode !== "143" || !logs(web).includes("start-server process cleanup finished")) throw new Error("CONTAINER_SMOKE_WEB_SHUTDOWN_FAILED");
  report.checks.webGracefulShutdown = "PASS";
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = error instanceof Error ? error.message.split("\n")[0] : "UNKNOWN";
  for (const name of names) { try { await writeFile(resolve(directory, `${name}.log`), logs(name)); } catch {} }
  process.exitCode = 1;
} finally {
  for (const name of names.reverse()) { try { docker(["stop", "--time", "30", name]); docker(["rm", "--volumes", name]); } catch { report.cleanupFailed = true; process.exitCode = 1; } }
  if (networkCreated) { try { docker(["network", "rm", prefix]); } catch { report.cleanupFailed = true; process.exitCode = 1; } }
  await rm(envPath, { force: true });
  report.completedAt = new Date().toISOString();
  await writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
