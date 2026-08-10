import { configureIntegrationTestEnvironment } from "@ai-cognitive/shared";
process.env.NODE_ENV ??= "test";
process.env.NODE_ENV = "test";
configureIntegrationTestEnvironment(process.env);
