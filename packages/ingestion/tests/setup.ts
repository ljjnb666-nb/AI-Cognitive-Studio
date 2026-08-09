if (!process.env.DATABASE_URL_TEST) {
  throw new Error("DATABASE_URL_TEST is required for ingestion integration tests.");
}

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
