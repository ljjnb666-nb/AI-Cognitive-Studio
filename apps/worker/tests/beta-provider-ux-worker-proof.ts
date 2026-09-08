import { createHash } from "node:crypto";
import { createBookProductionGatewayRuntime } from "../src/provider-gateway-runtime.js";

const workspaceId = process.env.BETA_PROVIDER_UX_WORKSPACE_ID, userId = process.env.BETA_PROVIDER_UX_USER_ID;
if (!workspaceId || !userId) throw new Error("BETA_PROVIDER_UX_WORKER_PROOF_IDENTITY_REQUIRED");
let credentialHash = "";
const controls = { circuit: { admit: async () => undefined, recordSuccess: async () => undefined, recordRetryableFailure: async () => undefined }, rate: { admit: async () => undefined }, concurrency: { acquire: async (key: string) => ({ key, token: "beta-provider" }), release: async () => true }, validateEndpoint: async () => undefined };
const workerEnvironment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development" };
delete workerEnvironment.PROVIDER_GATEWAY_MODEL_MANIFEST;
delete workerEnvironment.PROVIDER_GATEWAY_KEYRING;
const runtime = createBookProductionGatewayRuntime(workerEnvironment, { ...controls, adapterResolver: () => ({ execute: async ({ credential }: { credential?: string }) => { credentialHash = createHash("sha256").update(credential ?? "").digest("hex"); return { response: { type: "TEXT" as const, text: "worker-ok" }, usage: { inputTokens: 1, outputTokens: 1 }, remoteRequestId: "beta-worker" }; } }) });
try {
  const outcome = await runtime.gateway.execute({ workspaceId, routeSlot: "BOOK_CHUNK_ANALYSIS", correlationId: "beta-worker", idempotencyKey: `beta-worker-${workspaceId}`, inputHash: createHash("sha256").update(workspaceId).digest("hex"), capability: { family: "TEXT_GENERATION", structuredOutput: "STRICT_JSON_SCHEMA" }, text: { messages: [{ role: "user", content: "prove worker keyring" }] } }, { userId });
  process.stdout.write(JSON.stringify({ status: outcome.status, credentialHash }));
} finally { await runtime.close(); }
