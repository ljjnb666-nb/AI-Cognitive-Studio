import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BlockExtractionProvenance, CanonicalSourceLocator, ExtractionQualityWarningCode, SourceBlockBbox } from "@ai-cognitive/domain";
import { normalizeCanonicalText, splitCanonicalBlock } from "./canonical-text.js";
import { parseEpub } from "./epub-parser.js";
import { SourceError, sourceErrorForParserResult } from "./source-errors.js";

export type SourceBlockKind = "HEADING" | "PARAGRAPH" | "LIST_ITEM" | "QUOTE" | "TABLE" | "IMAGE" | "CAPTION" | "FOOTNOTE" | "CODE" | "EQUATION" | "UNKNOWN";
export type ParsedBlock = { kind: SourceBlockKind; text: string; locator?: CanonicalSourceLocator; provenance?: BlockExtractionProvenance; bbox?: SourceBlockBbox; metadata?: Record<string, unknown> };
/**
 * qualityWarnings/formatMetadata are format-native extensions: only the EPUB
 * parser produces them today (typed EpubExtractionMetadata plus stable warning
 * codes); PDF/TXT/Markdown keep them unset and an empty warning list.
 */
export type Parsed = { parser: { name: string; version: string }; pages: Array<{ physicalPageIndex: number | null; blocks: ParsedBlock[] }>; qualityWarnings?: ExtractionQualityWarningCode[]; formatMetadata?: unknown };
export type ParserLimits = { maxPdfPages: number; maxPdfOutputChars: number; pdfTimeoutMs: number; pdfMemoryMb: number; maxPdfIpcBytes: number; maxPdfStderrBytes: number; pdfChildEntry?: string; maxArchiveEntries: number; maxArchiveEntryBytes: number; maxArchiveTotalBytes: number; maxArchiveCompressionRatio: number; maxEpubXmlChars: number; maxEpubNavigationEntries: number };
export const DEFAULT_PARSER_LIMITS: ParserLimits = { maxPdfPages: 2000, maxPdfOutputChars: 20_000_000, pdfTimeoutMs: 30_000, pdfMemoryMb: 128, maxPdfIpcBytes: 24_000_000, maxPdfStderrBytes: 32_000, maxArchiveEntries: 10_000, maxArchiveEntryBytes: 25_000_000, maxArchiveTotalBytes: 100_000_000, maxArchiveCompressionRatio: 100, maxEpubXmlChars: 8_000_000, maxEpubNavigationEntries: 20_000 };

const parsers = {
  text: { name: "builtin-text", version: "text-parser-v1", sourceMethod: "NATIVE_TEXT" },
  markdown: { name: "builtin-markdown", version: "markdown-parser-v1", sourceMethod: "STRUCTURED_MARKUP" },
  pdf: { name: "pdfjs-isolated", version: "pdf-isolation-v3", sourceMethod: "NATIVE_TEXT" },
  epub: { name: "builtin-epub", version: "epub-parser-v2", sourceMethod: "STRUCTURED_MARKUP" },
} as const;
export type ParserDescriptor = (typeof parsers)[keyof typeof parsers];

/**
 * Block-level provenance for a parser run. Extracted as the single authority so
 * the extraction-level columns and every produced block stay consistent.
 */
export function blockProvenance(parser: ParserDescriptor): BlockExtractionProvenance {
  return { sourceMethod: parser.sourceMethod, parserName: parser.name, parserVersion: parser.version };
}

export async function parseDocument(bytes: Uint8Array, mediaType: string, limits: Partial<ParserLimits> = {}): Promise<Parsed> {
  const effective = { ...DEFAULT_PARSER_LIMITS, ...limits };
  if (mediaType === "text/plain") return blocksFromText(decodeUtf8Text(bytes), "PARAGRAPH", parsers.text);
  if (mediaType === "text/markdown") return { parser: parsers.markdown, pages: [{ physicalPageIndex: null, blocks: markdownBlocks(decodeUtf8Text(bytes), parsers.markdown) }] };
  if (mediaType === "application/pdf") return parsePdf(bytes, effective);
  if (mediaType === "application/epub+zip") return parseEpub(bytes, effective, parsers.epub);
  throw new Error(SourceError.UNSUPPORTED_TYPE);
}

function decodeUtf8Text(bytes: Uint8Array): string { if (bytes.includes(0)) throw new Error(SourceError.TYPE_MISMATCH); try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(SourceError.CORRUPTED); } }
function splitText(text: string): string[] { return normalizeCanonicalText(text, { stripDocumentBom: true }).split(/\n[ \t]*\n+/).flatMap((part) => splitCanonicalBlock(normalizeCanonicalText(part))).filter(Boolean); }
// Plain-text formats have no locatable pages in the canonical union; they record
// provenance only and never fabricate a locator.
function blocksFromText(text: string, kind: SourceBlockKind, parser: ParserDescriptor): Parsed { return { parser, pages: [{ physicalPageIndex: null, blocks: splitText(text).map((text) => ({ kind, text, provenance: blockProvenance(parser) })) }] }; }
function markdownBlocks(text: string, parser: ParserDescriptor): ParsedBlock[] { return splitText(text).map((text) => ({ kind: /^#{1,6}\s/.test(text) ? "HEADING" : /^[-*+]\s/.test(text) ? "LIST_ITEM" : /^>\s/.test(text) ? "QUOTE" : /^```/.test(text) ? "CODE" : "PARAGRAPH", text, provenance: blockProvenance(parser) })); }

/**
 * Runs PDF.js in a dedicated Node process with a V8 heap limit; the worker never parses untrusted PDFs.
 */
async function parsePdf(bytes: Uint8Array, limits: ParserLimits): Promise<Parsed> {
  if (!Buffer.from(bytes.subarray(0, 8)).toString("ascii").startsWith("%PDF-")) throw new Error(SourceError.CORRUPTED);
  const dir = join(tmpdir(), `ai-cognitive-pdf-${randomUUID()}`); const input = join(dir, "source.pdf");
  try {
    await mkdir(dir); await writeFile(input, bytes);
    const child = await runPdfChild(input, limits); if (child.error) throw new Error(child.error);
    const provenance = blockProvenance(parsers.pdf);
    // pdfjs text extraction has no geometry here: no bbox and no confidence may
    // be fabricated, and the printed page label is unknown.
    const pages = child.pages.map(({ physicalPageIndex, text }) => ({ physicalPageIndex, blocks: splitText(text).map((value) => ({ kind: "PARAGRAPH" as const, text: value, locator: { kind: "pdf", physicalPageIndex, printedPageLabel: null } satisfies CanonicalSourceLocator, provenance })) }));
    if (!pages.some((page) => page.blocks.length)) throw new Error(SourceError.OCR_REQUIRED);
    return { parser: parsers.pdf, pages };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function pdfFailure(stderr: string): string { if (/password|encrypted/i.test(stderr)) return SourceError.PASSWORD_REQUIRED; if (/syntax error|damaged|xref|trailer/i.test(stderr)) return SourceError.CORRUPTED; return SourceError.PARSE; }
export function pdfChildArgs(input: string, limits: ParserLimits): string[] { return [`--max-old-space-size=${limits.pdfMemoryMb}`, limits.pdfChildEntry ?? fileURLToPath(new URL("./pdf-parser-child.mjs", import.meta.url)), input, String(limits.maxPdfPages), String(limits.maxPdfOutputChars)]; }
async function runPdfChild(input: string, limits: ParserLimits): Promise<{ pages: Array<{ physicalPageIndex: number; text: string }>; error?: string }> { return new Promise((resolve, reject) => { const child = spawn(process.execPath, pdfChildArgs(input, limits), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "", stdoutBytes = 0, stderrBytes = 0, settled = false, parentStop: string | null = null; const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } }; const stop = (error: string) => { parentStop = error; child.kill(); finish(() => reject(new Error(error))); }; const timer = setTimeout(() => stop(SourceError.PARSE_TIMEOUT), limits.pdfTimeoutMs); child.stdout.on("data", (data: Buffer) => { stdoutBytes += data.length; if (stdoutBytes > limits.maxPdfIpcBytes) stop(SourceError.TOO_LARGE); else stdout += data.toString("utf8"); }); child.stderr.on("data", (data: Buffer) => { stderrBytes += data.length; if (stderrBytes > limits.maxPdfStderrBytes) stop(SourceError.PARSE); else stderr += data.toString("utf8"); }); child.on("error", () => finish(() => reject(new Error(SourceError.PARSE)))); child.on("close", (code, signal) => finish(() => { if (parentStop || signal || code !== 0 && !stdout.includes('"type":"error"')) return reject(new Error(SourceError.PARSE)); try { const records = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); const failure = records.find((record) => record.type === "error"); if (failure?.code) return resolve({ pages: [], error: failure.code }); const meta = records.find((record) => record.type === "meta"), complete = records.at(-1)?.type === "done"; if (!meta || !complete) return reject(new Error(SourceError.PARSE)); resolve({ pages: records.filter((record) => record.type === "page") }); } catch { reject(new Error(pdfFailure(stderr))); } })); }); }
export async function runNative(command: string, args: string[], timeoutMs: number, maxStderr: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "", timedOut = false;
    const add = (current: string, value: Buffer) => current.length + value.length > maxStderr ? current + value.subarray(0, maxStderr - current.length).toString("utf8") : current + value.toString("utf8");
    child.stdout.on("data", (value: Buffer) => { stdout = add(stdout, value); }); child.stderr.on("data", (value: Buffer) => { stderr = add(stderr, value); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); reject(new Error(SourceError.PARSE)); });
    child.on("close", (code) => { clearTimeout(timer); if (timedOut) reject(new Error(SourceError.PARSE_TIMEOUT)); else resolve({ code, stdout, stderr }); });
  });
}

export const parserResultToSourceError = sourceErrorForParserResult;
