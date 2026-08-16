import { ProviderGatewayError } from "../errors.js";
import type { TextGenerationInput } from "../types.js";
import { compileStrictJsonSchema } from "./strict-json-schema.js";

const limits = { messages: 256, system: 100_000, message: 200_000, total: 1_000_000, schema: 200_000, schemaName: 64, output: 128_000 };
export function validateTextGenerationInput(input: TextGenerationInput | undefined): void {
  if (!input) return;
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > limits.messages) throw invalid();
  let total = input.system?.length ?? 0;
  if (total > limits.system) throw invalid();
  for (const message of input.messages) { if (!message || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string" || message.content.length > limits.message) throw invalid(); total += message.content.length; }
  if (total > limits.total) throw invalid();
  const generation = input.generation;
  if (generation && ((!integer(generation.maxOutputTokens, 1, limits.output)) || (!number(generation.temperature, 0, 2)) || (!number(generation.topP, 0, 1)))) throw invalid();
  const structured = input.structuredOutput;
  if (structured) {
    if (!structured.mode || structured.mode === "STRICT_JSON_SCHEMA" && (!structured.schemaName || !structured.schema)) throw invalid();
    if (structured.schemaName && (!/^[A-Za-z0-9_-]{1,64}$/.test(structured.schemaName) || structured.schemaName.length > limits.schemaName)) throw invalid();
    if (structured.mode === "STRICT_JSON_SCHEMA") validateStrictSchema(structured.schema);
  }
}
function validateStrictSchema(schema: unknown): void {
  if (!isJsonObject(schema) || serializedLength(schema) > limits.schema) throw invalid();
  try { compileStrictJsonSchema(schema); } catch { throw invalid(); }
}
function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const seen = new WeakSet<object>();
  const isJson = (entry: unknown): boolean => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (!entry || typeof entry !== "object") return false;
    if (seen.has(entry)) return false;
    seen.add(entry);
    return Array.isArray(entry) ? entry.every(isJson) : Object.values(entry).every(isJson);
  };
  return isJson(value);
}
function serializedLength(schema: Record<string, unknown>): number {
  try { const serialized = JSON.stringify(schema); if (typeof serialized !== "string") throw new Error(); return serialized.length; } catch { throw invalid(); }
}
function integer(value: number | undefined, min: number, max: number): boolean { return value === undefined || Number.isSafeInteger(value) && value >= min && value <= max; }
function number(value: number | undefined, min: number, max: number): boolean { return value === undefined || Number.isFinite(value) && value >= min && value <= max; }
function invalid(): ProviderGatewayError { return new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Invalid text generation input"); }
