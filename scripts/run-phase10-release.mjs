import { execFileSync, spawnSync } from "node:child_process";

const root = process.cwd();
const database = "ai_cognitive_studio_phase10_test";
const port = process.env.POSTGRES_HOST_PORT ?? "5433";
const environment = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL: `postgresql://app:app@localhost:${port}/${database}?schema=public`,
  DATABASE_URL_TEST: `postgresql://app:app@localhost:${port}/${database}?schema=public`,
  BETTER_AUTH_SECRET: "phase10-test-secret-must-be-at-least-32-characters",
  BETTER_AUTH_URL: "http://localhost:3001",
  BETTER_AUTH_TRUSTED_ORIGINS: "http://localhost:3001",
  WEB_DEV_BOOTSTRAP_IDENTITY: "false",
};

function command(program, args) {
  const result = process.platform === "win32" && program === "pnpm"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `pnpm ${args.join(" ")}`], { cwd: root, env: environment, stdio: "inherit", shell: false })
    : spawnSync(program, args, { cwd: root, env: environment, stdio: "inherit", shell: false });
  if (result.status !== 0) throw new Error(`PHASE10_COMMAND_FAILED:${program}`);
}

function postgres(sql) {
  if (process.env.PHASE10_POSTGRES_CONTAINER) {
    execFileSync("docker", ["exec", "-i", process.env.PHASE10_POSTGRES_CONTAINER, "psql", "-U", "app", "-d", "postgres", "-c", sql], { cwd: root, env: environment, stdio: "inherit" });
    return;
  }
  try {
    execFileSync("psql", ["-h", "localhost", "-p", port, "-U", "app", "-d", "postgres", "-c", sql], { cwd: root, env: { ...environment, PGPASSWORD: "app" }, stdio: "inherit" });
  } catch {
    command("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "app", "-d", "postgres", "-c", sql]);
  }
}

try {
  postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
  postgres(`CREATE DATABASE ${database};`);
  command("pnpm", ["db:migrate:deploy"]);
  command("pnpm", ["--filter", "@ai-cognitive/web", "exec", "vitest", "run", "--config", "vitest.integration.config.mts", "tests/phase10-cognitions.integration.test.ts"]);
  command("pnpm", ["--filter", "@ai-cognitive/web", "build"]);
  command("pnpm", ["--filter", "@ai-cognitive/web", "exec", "playwright", "test", "--config", "playwright.phase10.config.ts"]);
} finally {
  postgres(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
}
