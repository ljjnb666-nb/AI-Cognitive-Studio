import { readFile } from "node:fs/promises";
import { parseEpub } from "./epub-parser.js";
import { SourceError } from "./source-errors.js";
import type { ParserDescriptor, ParserLimits } from "./document-parsers.js";

const input = process.argv[2];
const encodedLimits = process.argv[3];

const parser = {
  name: "builtin-epub",
  version: "epub-parser-v2",
  sourceMethod: "STRUCTURED_MARKUP",
} as const satisfies ParserDescriptor;

const stableSourceErrors = new Set<string>(Object.values(SourceError));

async function main(): Promise<void> {
  if (!input || !encodedLimits) throw new Error(SourceError.PARSE);
  let limits: ParserLimits;
  try {
    limits = JSON.parse(Buffer.from(encodedLimits, "base64url").toString("utf8")) as ParserLimits;
  } catch {
    throw new Error(SourceError.PARSE);
  }
  const bytes = await readFile(input);
  const parsed = parseEpub(bytes, limits, parser);
  process.stdout.write(JSON.stringify({ type: "result", parsed }) + "\n");
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message.split(":")[0]! : SourceError.PARSE;
  const code = stableSourceErrors.has(message) ? message : SourceError.PARSE;
  process.stdout.write(JSON.stringify({ type: "error", code }) + "\n");
}
