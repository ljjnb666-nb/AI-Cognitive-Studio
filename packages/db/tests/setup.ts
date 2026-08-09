import { config } from "dotenv";

config({ path: "../../.env" });

if (!process.env.DATABASE_URL_TEST) {
  throw new Error("DATABASE_URL_TEST is required for database integration tests.");
}

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
