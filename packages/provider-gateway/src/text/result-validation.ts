import { ProviderGatewayError } from "../errors.js";
import type { TextGenerationResponse } from "../types.js";

export const TEXT_RESULT_MAX_PLAINTEXT_BYTES = 256 * 1024;
const finishReasons = new Set(["STOP", "LENGTH", "CONTENT_FILTER", "OTHER"]);

function jsonSafe(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return false;
  seen.add(value);
  return Array.isArray(value) ? value.every(item => jsonSafe(item, seen)) : Object.values(value).every(item => jsonSafe(item, seen));
}

export function validateTextGenerationResponse(value: unknown): TextGenerationResponse {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const response = value as TextGenerationResponse;
  if ((response.type !== "TEXT" && response.type !== "STRUCTURED") || (response.finishReason !== undefined && !finishReasons.has(response.finishReason)) || (response.providerModel !== undefined && (typeof response.providerModel !== "string" || response.providerModel.length > 512))) throw invalid();
  if (response.type === "TEXT") { if (typeof response.text !== "string" || !response.text.trim() || response.structured !== undefined) throw invalid(); }
  else if (response.text !== undefined || response.structured === undefined || !jsonSafe(response.structured)) throw invalid();
  let serialized: string;
  try { serialized = JSON.stringify(response); } catch { throw invalid(); }
  if (Buffer.byteLength(serialized, "utf8") > TEXT_RESULT_MAX_PLAINTEXT_BYTES) throw new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "TEXT_RESULT_MAX_PLAINTEXT_BYTES");
  return response;
}
function invalid(): ProviderGatewayError { return new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Invalid text generation response"); }
