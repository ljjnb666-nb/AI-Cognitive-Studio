import { prisma } from "@ai-cognitive/db";
import { createRedisConnection } from "@ai-cognitive/shared/server";
import { storage } from "./storage";

export type ReadinessCheck = { name: "database" | "redis" | "objectStorage"; ok: boolean; code?: string };
export type Readiness = { status: "ready" | "not_ready"; service: "web"; checks: ReadinessCheck[] };

function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "DEPENDENCY_UNAVAILABLE";
  return /[A-Z][A-Z0-9_]{2,}/.exec(value)?.[0] ?? "DEPENDENCY_UNAVAILABLE";
}

/** Provider status is deliberately excluded: a single upstream must not make Studio itself unready. */
type ReadinessDependencies = { database(): Promise<unknown>; redis(): Promise<unknown>; objectStorage(): Promise<unknown> };
const defaultDependencies: ReadinessDependencies = {
  database: () => prisma.$queryRaw`SELECT 1`,
  redis: async () => { const client = createRedisConnection(process.env.REDIS_URL ?? "redis://127.0.0.1:6379"); try { await client.ping(); } finally { await client.quit(); } },
  objectStorage: async () => (await storage().bucketExists?.()) ?? false,
};
export async function checkReadiness(dependencies: ReadinessDependencies = defaultDependencies): Promise<Readiness> {
  const checks = await Promise.all(([["database", dependencies.database], ["redis", dependencies.redis], ["objectStorage", dependencies.objectStorage]] as const).map(async ([name, check]) => {
    try { const result = await check(); if (result === false) return { name, ok: false, code: "DEPENDENCY_UNAVAILABLE" } as ReadinessCheck; return { name, ok: true } as ReadinessCheck; }
    catch (error) { return { name, ok: false, code: safeCode(error) } as ReadinessCheck; }
  }));
  return { status: checks.every((check) => check.ok) ? "ready" : "not_ready", service: "web", checks };
}
