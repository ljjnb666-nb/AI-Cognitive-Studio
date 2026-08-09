import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { normalizeCanonicalText, splitCanonicalBlock } from "./canonical-text.js";
import { SourceError, sourceErrorForParserResult } from "./source-errors.js";

export type SourceBlockKind = "HEADING" | "PARAGRAPH" | "LIST_ITEM" | "QUOTE" | "TABLE" | "IMAGE" | "CAPTION" | "FOOTNOTE" | "CODE" | "EQUATION" | "UNKNOWN";
export type ParsedBlock = { kind: SourceBlockKind; text: string; metadata?: Record<string, unknown> };
export type Parsed = { parser: { name: string; version: string }; pages: Array<{ physicalPageIndex: number | null; blocks: ParsedBlock[] }> };
export type ParserLimits = { maxPdfPages: number; maxPdfOutputChars: number; pdfTimeoutMs: number; pdfMemoryMb: number; maxPdfIpcBytes: number; maxPdfStderrBytes: number; maxArchiveEntries: number; maxArchiveEntryBytes: number; maxArchiveTotalBytes: number; maxArchiveCompressionRatio: number };
export const DEFAULT_PARSER_LIMITS: ParserLimits = { maxPdfPages: 2000, maxPdfOutputChars: 20_000_000, pdfTimeoutMs: 30_000, pdfMemoryMb: 128, maxPdfIpcBytes: 24_000_000, maxPdfStderrBytes: 32_000, maxArchiveEntries: 10_000, maxArchiveEntryBytes: 25_000_000, maxArchiveTotalBytes: 100_000_000, maxArchiveCompressionRatio: 100 };

const parsers = { text: { name: "builtin-text", version: "text-parser-v1" }, markdown: { name: "builtin-markdown", version: "markdown-parser-v1" }, pdf: { name: "pdfjs-isolated", version: "pdf-isolation-v3" }, epub: { name: "builtin-epub", version: "epub-parser-v1" } };

export async function parseDocument(bytes: Uint8Array, mediaType: string, limits: Partial<ParserLimits> = {}): Promise<Parsed> {
  const effective = { ...DEFAULT_PARSER_LIMITS, ...limits };
  if (mediaType === "text/plain") return blocksFromText(decodeUtf8Text(bytes), "PARAGRAPH", parsers.text);
  if (mediaType === "text/markdown") return { parser: parsers.markdown, pages: [{ physicalPageIndex: null, blocks: markdownBlocks(decodeUtf8Text(bytes)) }] };
  if (mediaType === "application/pdf") return parsePdf(bytes, effective);
  if (mediaType === "application/epub+zip") return parseEpub(bytes, effective);
  throw new Error(SourceError.UNSUPPORTED_TYPE);
}

function decodeUtf8Text(bytes: Uint8Array): string { if (bytes.includes(0)) throw new Error(SourceError.TYPE_MISMATCH); try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(SourceError.CORRUPTED); } }
function splitText(text: string): string[] { return normalizeCanonicalText(text, { stripDocumentBom: true }).split(/\n[ \t]*\n+/).flatMap((part) => splitCanonicalBlock(normalizeCanonicalText(part))).filter(Boolean); }
function blocksFromText(text: string, kind: SourceBlockKind, parser: Parsed["parser"]): Parsed { return { parser, pages: [{ physicalPageIndex: null, blocks: splitText(text).map((text) => ({ kind, text })) }] }; }
function markdownBlocks(text: string): ParsedBlock[] { return splitText(text).map((text) => ({ kind: /^#{1,6}\s/.test(text) ? "HEADING" : /^[-*+]\s/.test(text) ? "LIST_ITEM" : /^>\s/.test(text) ? "QUOTE" : /^```/.test(text) ? "CODE" : "PARAGRAPH", text })); }

/**
 * Runs PDF.js in a dedicated Node process with a V8 heap limit; the worker never parses untrusted PDFs.
 */
async function parsePdf(bytes: Uint8Array, limits: ParserLimits): Promise<Parsed> {
  if (!Buffer.from(bytes.subarray(0, 8)).toString("ascii").startsWith("%PDF-")) throw new Error(SourceError.CORRUPTED);
  const dir = join(tmpdir(), `ai-cognitive-pdf-${randomUUID()}`); const input = join(dir, "source.pdf");
  try {
    await mkdir(dir); await writeFile(input, bytes);
    const child = await runPdfChild(input, limits); if (child.error) throw new Error(child.error);
    const pages = child.pages.map(({ physicalPageIndex, text }) => ({ physicalPageIndex, blocks: splitText(text).map((value) => ({ kind: "PARAGRAPH" as const, text: value })) }));
    if (!pages.some((page) => page.blocks.length)) throw new Error(SourceError.OCR_REQUIRED);
    return { parser: parsers.pdf, pages };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
function pdfFailure(stderr: string): string { if (/password|encrypted/i.test(stderr)) return SourceError.PASSWORD_REQUIRED; if (/syntax error|damaged|xref|trailer/i.test(stderr)) return SourceError.CORRUPTED; return SourceError.PARSE; }
export function pdfChildArgs(input: string, limits: ParserLimits): string[] { return [`--max-old-space-size=${limits.pdfMemoryMb}`, fileURLToPath(new URL("./pdf-parser-child.mjs", import.meta.url)), input, String(limits.maxPdfPages), String(limits.maxPdfOutputChars)]; }
async function runPdfChild(input: string, limits: ParserLimits): Promise<{ pages: Array<{ physicalPageIndex: number; text: string }>; error?: string }> { return new Promise((resolve, reject) => { const child = spawn(process.execPath, pdfChildArgs(input, limits), { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "", done = false; const finish = (fn: () => void) => { if (!done) { done = true; clearTimeout(timer); fn(); } }; const timer = setTimeout(() => { child.kill(); finish(() => reject(new Error(SourceError.PARSE_TIMEOUT))); }, limits.pdfTimeoutMs); const capture = (current: string, data: Buffer, max: number) => current.length + data.length > max ? null : current + data.toString("utf8"); child.stdout.on("data", (data: Buffer) => { const next = capture(stdout, data, limits.maxPdfIpcBytes); if (next === null) { child.kill(); finish(() => reject(new Error(SourceError.TOO_LARGE))); } else stdout = next; }); child.stderr.on("data", (data: Buffer) => { const next = capture(stderr, data, limits.maxPdfStderrBytes); if (next === null) { child.kill(); finish(() => reject(new Error(SourceError.PARSE))); } else stderr = next; }); child.on("error", () => finish(() => reject(new Error(SourceError.PARSE)))); child.on("close", () => finish(() => { try { const records = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); const failure = records.find((record) => record.type === "error"); resolve({ pages: records.filter((record) => record.type === "page"), error: failure?.code }); } catch { reject(new Error(pdfFailure(stderr))); } })); }); }
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

type ZipEntry = { name: string; method: number; flags: number; compressed: Buffer; compressedSize: number; uncompressedSize: number };
function parseEpub(bytes: Uint8Array, limits: ParserLimits): Parsed {
  const entries = readZip(bytes, limits); const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const mimetype = entryText(byName, "mimetype", limits); if (mimetype !== "application/epub+zip") throw new Error(SourceError.CORRUPTED);
  if (byName.has("META-INF/encryption.xml")) throw new Error(SourceError.ARCHIVE_UNSAFE);
  const container = safeXml(entryText(byName, "META-INF/container.xml", limits)); const opfPath = attr(container, /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i); if (!opfPath || !isSafePath(opfPath)) throw new Error(SourceError.CORRUPTED);
  const opf = safeXml(entryText(byName, opfPath, limits)); const manifest = new Map<string, string>();
  for (const match of opf.matchAll(/<item\b([^>]*)>/gi)) { const attributes = match[1] ?? ""; const id = attr(attributes, /\bid\s*=\s*["']([^"']+)["']/i); const href = attr(attributes, /\bhref\s*=\s*["']([^"']+)["']/i); if (id && href) manifest.set(id, resolvePath(opfPath, href)); }
  const spineIds = [...opf.matchAll(/<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]).filter((id): id is string => typeof id === "string"); if (!spineIds.length) throw new Error(SourceError.CORRUPTED);
  const blocks: ParsedBlock[] = [];
  spineIds.forEach((id, spineIndex) => { const href = manifest.get(id); if (!href || !isSafePath(href)) throw new Error(SourceError.CORRUPTED); const xhtml = safeXml(entryText(byName, href, limits)); if (/\b(?:src|href)\s*=\s*["'](?:https?:|file:)/i.test(xhtml)) throw new Error(SourceError.ARCHIVE_UNSAFE); blocks.push(...xhtmlBlocks(xhtml, { spineIndex, href })); });
  return { parser: parsers.epub, pages: [{ physicalPageIndex: null, blocks }] };
}
function readZip(bytes: Uint8Array, limits: ParserLimits): ZipEntry[] {
  const data = Buffer.from(bytes); const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])); if (eocd < 0 || eocd + 22 > data.length) throw new Error(SourceError.CORRUPTED);
  const count = data.readUInt16LE(eocd + 10), directoryOffset = data.readUInt32LE(eocd + 16); if (count > limits.maxArchiveEntries || directoryOffset >= data.length) throw new Error(SourceError.ARCHIVE_UNSAFE);
  let offset = directoryOffset, total = 0; const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index++) { if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error(SourceError.CORRUPTED); const flags = data.readUInt16LE(offset + 8), method = data.readUInt16LE(offset + 10), compressedSize = data.readUInt32LE(offset + 20), uncompressedSize = data.readUInt32LE(offset + 24), nameLength = data.readUInt16LE(offset + 28), extraLength = data.readUInt16LE(offset + 30), commentLength = data.readUInt16LE(offset + 32), localOffset = data.readUInt32LE(offset + 42); const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if ((flags & 1) || !isSafePath(name) || uncompressedSize > limits.maxArchiveEntryBytes || (compressedSize && uncompressedSize / compressedSize > limits.maxArchiveCompressionRatio)) throw new Error(SourceError.ARCHIVE_UNSAFE); total += uncompressedSize; if (total > limits.maxArchiveTotalBytes || data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(SourceError.ARCHIVE_UNSAFE);
    const localName = data.readUInt16LE(localOffset + 26), localExtra = data.readUInt16LE(localOffset + 28), start = localOffset + 30 + localName + localExtra; entries.push({ name, method, flags, compressed: data.subarray(start, start + compressedSize), compressedSize, uncompressedSize }); offset += 46 + nameLength + extraLength + commentLength;
  } return entries;
}
function entryText(entries: Map<string, ZipEntry>, name: string, limits: ParserLimits): string { const entry = entries.get(name); if (!entry) throw new Error(SourceError.CORRUPTED); let data: Buffer; try { data = entry.method === 0 ? entry.compressed : entry.method === 8 ? inflateRawSync(entry.compressed, { maxOutputLength: limits.maxArchiveEntryBytes }) : (() => { throw new Error("unsupported"); })(); } catch { throw new Error(SourceError.ARCHIVE_UNSAFE); } if (data.length !== entry.uncompressedSize) throw new Error(SourceError.CORRUPTED); try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new Error(SourceError.CORRUPTED); } }
function isSafePath(path: string): boolean { return !!path && !/^(?:[\\/]|[a-zA-Z]:|\\\\)/.test(path) && !path.split(/[\\/]/).some((part) => part === ".." || !part) && !/%2e|%2f|%5c/i.test(path); }
function resolvePath(base: string, href: string): string { if (/^[a-z]+:/i.test(href)) return href; const parts = base.split("/"); parts.pop(); for (const part of href.split("/")) { if (!part || part === ".") continue; if (part === "..") return "../invalid"; parts.push(part); } return parts.join("/"); }
function safeXml(xml: string): string { if (/<!DOCTYPE|<!ENTITY|\bSYSTEM\b|\bPUBLIC\b/i.test(xml)) throw new Error(SourceError.ARCHIVE_UNSAFE); return xml; }
function attr(value: string, expression: RegExp): string | null { return expression.exec(value)?.[1] ?? null; }
function xhtmlBlocks(xhtml: string, metadata: Record<string, unknown>): ParsedBlock[] { const safe = xhtml.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ""); const blocks: ParsedBlock[] = []; for (const match of safe.matchAll(/<(h[1-6]|p|li|blockquote|pre|code)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) { const tag = match[1] ?? ""; const body = match[2] ?? ""; const text = normalizeCanonicalText(body.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")); const kind: SourceBlockKind = /^h/i.test(tag) ? "HEADING" : /^li$/i.test(tag) ? "LIST_ITEM" : /^blockquote$/i.test(tag) ? "QUOTE" : /^(pre|code)$/i.test(tag) ? "CODE" : "PARAGRAPH"; for (const chunk of splitCanonicalBlock(text)) if (chunk) blocks.push({ kind, text: chunk, metadata }); } return blocks; }

export const parserResultToSourceError = sourceErrorForParserResult;
