import { ProviderGatewayError } from "../errors.js";
import type { JsonSchema, TextGenerationInput, TextGenerationResponse } from "../types.js";

export function normalizeTextResponse(text: string, providerModel: string | undefined, finishReason: TextGenerationResponse["finishReason"], input: TextGenerationInput): TextGenerationResponse {
  const structured = input.structuredOutput;
  if (!structured) return { type: "TEXT", text, providerModel, finishReason };
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  if (structured.mode === "STRICT_JSON_SCHEMA" && !matchesSchema(value, structured.schema!)) throw invalid();
  return { type: "STRUCTURED", structured: value, providerModel, finishReason };
}
function invalid(): ProviderGatewayError { return new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Provider returned invalid structured output"); }
function matchesSchema(value: unknown, schema: JsonSchema): boolean {
  const type = schema.type; if (Array.isArray(type) && !type.some(item => matchesSchema(value, { ...schema, type: item }))) return false;
  if (type === "object") { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const object = value as Record<string, unknown>; const required = Array.isArray(schema.required) ? schema.required : []; if (required.some(key => typeof key !== "string" || !(key in object))) return false; const properties = schema.properties; if (properties && typeof properties === "object" && !Array.isArray(properties)) for (const [key, child] of Object.entries(properties as Record<string, unknown>)) if (key in object && child && typeof child === "object" && !matchesSchema(object[key], child as JsonSchema)) return false; }
  if (type === "array" && (!Array.isArray(value) || (schema.items && typeof schema.items === "object" && !value.every(item => matchesSchema(item, schema.items as JsonSchema))))) return false;
  if (type === "string" && typeof value !== "string" || type === "number" && typeof value !== "number" || type === "integer" && (!Number.isInteger(value)) || type === "boolean" && typeof value !== "boolean" || type === "null" && value !== null) return false;
  return true;
}
