import { config } from "dotenv";

config({ path: "../../.env" });

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is required for queue integration tests.");
}
