process.env.NODE_ENV = "test";
process.env.DATABASE_URL_TEST ??= "postgresql://app:app@localhost:5433/ai_cognitive_studio_test?schema=public";
if (!/(?:^|_)test$/i.test(new URL(process.env.DATABASE_URL_TEST).pathname.replace(/^\//, ""))) throw new Error("DATABASE_URL_TEST_MUST_TARGET_TEST_DATABASE");
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
