import { configureIntegrationTestEnvironment } from "@ai-cognitive/shared";
import { existsSync, readFileSync } from "node:fs";
process.env.NODE_ENV = "test";
if (existsSync("../../.env")) for (const line of readFileSync("../../.env", "utf8").split(/\r?\n/)) { const match = /^(DATABASE_URL_TEST)=(.*)$/.exec(line); const key = match?.[1], value = match?.[2]; if (key && value && !process.env[key]) process.env[key] = value; }
configureIntegrationTestEnvironment();
