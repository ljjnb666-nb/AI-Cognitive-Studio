import { stableHash } from "./routing/snapshot.js";
import { canonicalTextInputHash } from "./text/canonical-input.js";
import { canonicalEmbeddingInputHash } from "./embedding/validation.js";
import type { ExecutionSnapshot, GatewayRequest } from "./types.js";

/** The single idempotency identity used for both claims and pinned durable recovery. */
export function canonicalGatewayRequestFingerprint(snapshot: ExecutionSnapshot, request: GatewayRequest): string {
  return stableHash({ routeSlot: snapshot.routeSlot, providerKey: snapshot.providerKey, protocol: snapshot.protocol, modelId: snapshot.modelId, connectionId: snapshot.connectionId, credentialVersionId: snapshot.credentialVersionId, configuration: snapshot.configuration, capability: request.capability, promptVersion: request.promptVersion, schemaVersion: request.schemaVersion, pipelineVersion: request.pipelineVersion, inputHash: request.inputHash, ...(request.text ? { canonicalTextInputHash: canonicalTextInputHash(request.text) } : {}), ...(request.embedding ? { canonicalEmbeddingInputHash: canonicalEmbeddingInputHash(request.embedding) } : {}) });
}
