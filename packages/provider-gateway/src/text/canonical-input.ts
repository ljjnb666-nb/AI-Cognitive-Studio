import { stableHash } from "../routing/snapshot.js";
import type { TextGenerationInput } from "../types.js";

/** Hash only: callers must never persist the canonicalized runtime input. */
export function canonicalTextInputHash(input: TextGenerationInput): string {
  return stableHash({ system: input.system, messages: input.messages.map(message => ({ role: message.role, content: message.content })), generation: input.generation, structuredOutput: input.structuredOutput });
}
