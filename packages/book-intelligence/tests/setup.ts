import { configureIntegrationTestEnvironment } from "@ai-cognitive/shared";
import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

process.env.NODE_ENV ??= "test";
process.env.NODE_ENV = "test";
config({ path: resolve(here, "../../../.env"), override: false, quiet: true });
const databaseUrl = configureIntegrationTestEnvironment(process.env);
const expectedDatabase = new URL(databaseUrl).pathname.slice(1);

beforeAll(async () => {
  const { prisma } = await import("../../db/src/index.js");
  const rows = await prisma.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;

  if (rows[0]?.database !== expectedDatabase) {
    throw new Error("INTEGRATION_TEST_DATABASE_MISMATCH");
  }
});
