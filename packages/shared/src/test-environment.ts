const LOCAL_TEST_DATABASE_URL = "postgresql://app:app@localhost:5432/ai_cognitive_studio_test?schema=public";

/** Establishes the test-only database contract without ever defaulting production. */
export function configureIntegrationTestEnvironment(environment: NodeJS.ProcessEnv = process.env): string {
  const mutable = environment as Record<string, string | undefined>;
  mutable.NODE_ENV ??= "test";
  if (mutable.NODE_ENV === "production") throw new Error("INTEGRATION_TESTS_REFUSE_PRODUCTION");
  if (mutable.NODE_ENV !== "test") throw new Error("INTEGRATION_TESTS_REQUIRE_NODE_ENV_TEST");
  mutable.DATABASE_URL_TEST ??= LOCAL_TEST_DATABASE_URL;
  const url = new URL(mutable.DATABASE_URL_TEST);
  if (!/(?:^|_)test$/i.test(url.pathname.replace(/^\//, ""))) throw new Error("DATABASE_URL_TEST_MUST_TARGET_TEST_DATABASE");
  mutable.DATABASE_URL = mutable.DATABASE_URL_TEST;
  return mutable.DATABASE_URL_TEST;
}
