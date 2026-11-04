import { prisma } from "@ai-cognitive/db";
import { createRedisProbeConnection } from "@ai-cognitive/shared/server";
import { storage } from "./storage";

export type ReadinessCheck = { name: "database" | "redis" | "objectStorage"; ok: boolean; code?: string };
export type Readiness = { status: "ready" | "not_ready"; service: "web"; checks: ReadinessCheck[] };

/** Provider status is deliberately excluded: a single upstream must not make Studio itself unready. */
type ReadinessDependencies = { database(): Promise<unknown>; redis(): Promise<unknown>; objectStorage(): Promise<unknown> };
const defaultDependencies: ReadinessDependencies = {
  database: () => prisma.$transaction(async tx => { await tx.$executeRaw`SET LOCAL statement_timeout = '1500ms'`; return tx.$queryRaw`SELECT 1`; }, { maxWait: 1000, timeout: 1800 }),
  redis: async () => { const client = createRedisProbeConnection(process.env.REDIS_URL ?? "redis://127.0.0.1:6379"); try { await client.connect(); await client.ping(); } finally { client.disconnect(); } },
  objectStorage: async () => (await storage().bucketExists?.()) ?? false,
};
export async function checkReadiness(dependencies: ReadinessDependencies = defaultDependencies, timeoutMs = 2000): Promise<Readiness> {
  const checks = await Promise.all(([["database", "DATABASE_UNAVAILABLE", dependencies.database], ["redis", "REDIS_UNAVAILABLE", dependencies.redis], ["objectStorage", "OBJECT_STORAGE_UNAVAILABLE", dependencies.objectStorage]] as const).map(async ([name, code, check]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { const result = await Promise.race([Promise.resolve().then(check), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("READINESS_TIMEOUT")), timeoutMs); })]); if (result === false) return { name, ok: false, code: "DEPENDENCY_UNAVAILABLE" } as ReadinessCheck; return { name, ok: true } as ReadinessCheck; }
    catch { return { name, ok: false, code } as ReadinessCheck; }
    finally { if (timer) clearTimeout(timer); }
  }));
  return { status: checks.every((check) => check.ok) ? "ready" : "not_ready", service: "web", checks };
}
