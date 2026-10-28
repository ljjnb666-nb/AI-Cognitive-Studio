import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARSER_LIMITS, pdfChildArgs } from "../src/document-parsers.js";

// Opt-in only. Valid 151,495,200-byte, 271-physical-page PDF, entirely
// synthetic. No private book, paid AI, OCR, Gold or publication assertion.
const BYTES = 151_495_200;
const PAGES = 271;
const MAX_RSS_KIB = 512 * 1024;
const TIMEOUT_MS = 150_000;

async function makePdf(path: string) {
  const font = 3 + 2 * PAGES;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [" + Array.from({ length: PAGES }, (_, i) => (i + 3) + " 0 R").join(" ") + "] /Count " + PAGES + " >>",
  ];
  for (let i = 0; i < PAGES; i++) {
    objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " +
      font + " 0 R >> >> /Contents " + (3 + PAGES + i) + " 0 R >>");
  }
  for (let i = 0; i < PAGES; i++) {
    const text = "BT /F1 12 Tf 50 700 Td (Synthetic physical page " + (i + 1) + ") Tj ET\n";
    objects.push("<< /Length " + Buffer.byteLength(text) + " >>\nstream\n" + text + "endstream");
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  if (objects.length !== font) throw new Error("INVALID_SYNTHETIC_OBJECT_COUNT");
  let header = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(header));
    header += (i + 1) + " 0 obj\n" + objects[i] + "\nendobj\n";
  }
  const table = [
    "xref", "0 " + (font + 1), "0000000000 65535 f ",
    ...offsets.slice(1).map(x => String(x).padStart(10, "0") + " 00000 n "),
    "trailer", "<< /Size " + (font + 1) + " /Root 1 0 R >>",
    "startxref",
  ].join("\n");
  const headSize = Buffer.byteLength(header);
  let gap = BYTES - headSize - Buffer.byteLength(table + "\n0\n%%EOF\n");
  for (let i = 0; i < 8; i++) {
    const trailer = table + "\n" + (headSize + gap) + "\n%%EOF\n";
    const corrected = BYTES - headSize - Buffer.byteLength(trailer);
    if (gap === corrected) break;
    gap = corrected;
  }
  const trailer = table + "\n" + (headSize + gap) + "\n%%EOF\n";
  if (gap < 0 || headSize + gap + Buffer.byteLength(trailer) !== BYTES)
    throw new Error("INVALID_SYNTHETIC_PDF_SIZE");
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(header);
    const padding = Buffer.alloc(1024 * 1024, 0x20);
    for (let remaining = gap; remaining > 0;) {
      const count = Math.min(remaining, padding.length);
      await file.writeFile(padding.subarray(0, count));
      remaining -= count;
    }
    await file.writeFile(trailer);
    expect((await file.stat()).size).toBe(BYTES);
  } finally { await file.close(); }
}

async function parseAndMeasure(path: string) {
  if (process.platform !== "linux") throw new Error("LINUX_PROC_RSS_REQUIRED");
  const child = spawn(process.execPath, pdfChildArgs(path, {
    ...DEFAULT_PARSER_LIMITS, pdfMemoryMb: 128, maxPdfPages: PAGES, maxPdfOutputChars: 100_000,
  }), { stdio: ["ignore", "pipe", "pipe"] });
  if (!child.pid) throw new Error("PDF_CHILD_NOT_STARTED");
  let stdout = "", stderr = "", peakKiB = 0, samples = 0;
  let exceeded = false, timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, TIMEOUT_MS);
  const interval = setInterval(() => {
    void readFile("/proc/" + child.pid + "/status", "utf8").then(status => {
      const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      if (!match) return;
      samples++;
      peakKiB = Math.max(peakKiB, Number(match[1]));
      if (peakKiB > MAX_RSS_KIB) { exceeded = true; child.kill("SIGKILL"); }
    }).catch(() => { /* /proc vanishes after child exit */ });
  }, 25);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (part: string) => {
    stdout += part;
    if (stdout.length > 2_000_000) { exceeded = true; child.kill("SIGKILL"); }
  });
  child.stderr.on("data", (part: string) => {
    stderr += part;
    if (stderr.length > 64_000) { exceeded = true; child.kill("SIGKILL"); }
  });
  try {
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    expect(timedOut, "151.5MB parser exceeded 150-second limit").toBe(false);
    expect(exceeded, "parser exceeded 512MiB RSS or bounded IPC").toBe(false);
    expect(samples, "child RSS never sampled").toBeGreaterThan(0);
    expect(peakKiB).toBeLessThanOrEqual(MAX_RSS_KIB);
    expect(exit, stderr.slice(0, 2000)).toEqual({ code: 0, signal: null });
    const records = stdout.trim().split("\n").map(line => JSON.parse(line) as {
      type: string; pages?: number; physicalPageIndex?: number; text?: string;
    });
    expect(records[0]).toMatchObject({ type: "meta", pages: PAGES });
    expect(records.at(-1)?.type).toBe("done");
    const pages = records.filter(row => row.type === "page");
    expect(pages).toHaveLength(PAGES);
    expect(pages.map(row => row.physicalPageIndex)).toEqual(Array.from({ length: PAGES }, (_, i) => i));
    expect(pages[0]?.text).toContain("Synthetic physical page 1");
    expect(pages[66]?.text).toContain("Synthetic physical page 67");
    expect(pages[270]?.text).toContain("Synthetic physical page 271");
    return Math.round(peakKiB / 102.4) / 10;
  } finally {
    clearTimeout(timeout);
    clearInterval(interval);
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
}

describe.skipIf(process.env.PDF_LARGE_VALID_PARSER_PROOF !== "true")(
  "B03-size VALID synthetic PDF.js range parser peak-RSS proof",
  () => {
    it("parses 151,495,200 bytes and 271 physical pages within 512MiB child RSS", async () => {
      if (process.env.NODE_ENV !== "test" || process.platform !== "linux")
        throw new Error("LARGE_SYNTHETIC_PARSER_ISOLATION_REQUIRED");
      const dir = await mkdtemp(join(tmpdir(), "pdf-b03-size-valid-"));
      try {
        const path = join(dir, "synthetic-271-pages.pdf");
        await makePdf(path);
        const rssMiB = await parseAndMeasure(path);
        process.stdout.write("PDF_VALID_SYNTHETIC_BYTES=" + BYTES + "\n");
        process.stdout.write("PDF_VALID_SYNTHETIC_PAGES=" + PAGES + "\n");
        process.stdout.write("PDF_VALID_SYNTHETIC_PEAK_CHILD_RSS_MIB=" + rssMiB + "\n");
      } finally { await rm(dir, { recursive: true, force: true }); }
    }, TIMEOUT_MS + 30_000);
  },
);
