import { config } from "dotenv";

process.env.NODE_ENV = "test";
config({ path: "../../.env" });

if (process.env.NODE_ENV === "production") throw new Error("INTEGRATION_TESTS_REFUSE_PRODUCTION");
if (process.env.NODE_ENV !== "test") throw new Error("INTEGRATION_TESTS_REQUIRE_NODE_ENV_TEST");
process.env.DATABASE_URL_TEST ??= "postgresql://app:app@localhost:5432/ai_cognitive_studio_test?schema=public";
if (!/(?:^|_)test$/i.test(new URL(process.env.DATABASE_URL_TEST).pathname.replace(/^\//, ""))) throw new Error("DATABASE_URL_TEST_MUST_TARGET_TEST_DATABASE");
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
process.env.WORKSPACE_EXPENSIVE_OPERATION_LIMIT ??= "16";
