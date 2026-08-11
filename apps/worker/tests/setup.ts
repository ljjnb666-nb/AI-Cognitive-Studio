import { config } from "dotenv";
import { configureIntegrationTestEnvironment } from "@ai-cognitive/shared";

config({ path: "../../.env" });
process.env.NODE_ENV = "test";
configureIntegrationTestEnvironment(process.env);

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is required for queue integration tests.");
}
