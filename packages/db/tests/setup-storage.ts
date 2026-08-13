import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
process.env.NODE_ENV = "test";
process.env.DATABASE_URL_TEST ??= "postgresql://app:app@localhost:5432/ai_cognitive_studio_test?schema=public";
if (!/(?:^|_)test$/i.test(new URL(process.env.DATABASE_URL_TEST).pathname.replace(/^\//, ""))) throw new Error("DATABASE_URL_TEST_MUST_TARGET_TEST_DATABASE");
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;

for (const name of ["S3_ENDPOINT", "S3_PUBLIC_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"]) {
  if (!process.env[name]) throw new Error(`STORAGE_INTEGRATION_ENV_REQUIRED:${name}`);
}
