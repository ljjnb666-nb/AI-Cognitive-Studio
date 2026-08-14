import { configureIntegrationTestEnvironment } from "@ai-cognitive/shared";
import { config } from "dotenv";
process.env.NODE_ENV = "test";
config({ path: "../../.env", override: false, quiet: true });
configureIntegrationTestEnvironment(process.env);
