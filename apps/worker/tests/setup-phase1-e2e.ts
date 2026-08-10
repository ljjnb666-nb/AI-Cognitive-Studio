import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { configureIntegrationTestEnvironment } from "@ai-cognitive/shared";

process.env.NODE_ENV ??= "test";
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
process.env.NODE_ENV = "test";
configureIntegrationTestEnvironment(process.env);
