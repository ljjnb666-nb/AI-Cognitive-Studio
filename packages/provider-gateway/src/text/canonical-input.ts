import { stableHash } from "../routing/snapshot.js";
import type { TextGenerationInput } from "../types.js";

export const DEFAULT_OUTPUT_TOKEN_LIMIT = 4096;
export function withTextGenerationDefaults(input: TextGenerationInput): TextGenerationInput {
  return { ...input, generation: { ...input.generation, maxOutputTokens: input.generation?.maxOutputTokens ?? DEFAULT_OUTPUT_TOKEN_LIMIT } };
}

/** Hash only: callers must never persist the canonicalized runtime input. */
export function canonicalTextInputHash(input: TextGenerationInput): string {
  input = withTextGenerationDefaults(input);
  return stableHash({ system: input.system, messages: input.messages.map(message => ({ role: message.role, content: message.content, ...(message.image ? { image: { sha256: message.image.sha256, sourceSha256: message.image.sourceSha256, physicalPageIndex: message.image.physicalPageIndex, mediaType: message.image.mediaType } } : {}) })), generation: input.generation, structuredOutput: input.structuredOutput });
}
