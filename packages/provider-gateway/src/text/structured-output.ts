import Ajv from "ajv/dist/ajv.js";
import { ProviderGatewayError } from "../errors.js";
import type { TextGenerationInput, TextGenerationResponse } from "../types.js";

export function normalizeTextResponse(text: string, providerModel: string | undefined, finishReason: TextGenerationResponse["finishReason"], input: TextGenerationInput): TextGenerationResponse {
  const structured = input.structuredOutput;
  if (!structured || structured.mode === "PROMPT_ONLY") return { type: "TEXT", text, providerModel, finishReason };
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  if (structured.mode === "STRICT_JSON_SCHEMA") {
    try { const validator = new (Ajv as unknown as new (options: { allErrors: boolean; strict: boolean }) => { compile(schema: object): (data: unknown) => boolean })({ allErrors: false, strict: false }); if (!validator.compile(structured.schema!)(value)) throw invalid(); } catch (error) { if (error instanceof ProviderGatewayError) throw error; throw invalid(); }
  }
  return { type: "STRUCTURED", structured: value, providerModel, finishReason };
}
function invalid(): ProviderGatewayError { return new ProviderGatewayError("INVALID_PROVIDER_RESPONSE", "Provider returned invalid structured output"); }
