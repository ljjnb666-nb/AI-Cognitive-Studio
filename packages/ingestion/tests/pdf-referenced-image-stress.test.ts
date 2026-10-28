import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARSER_LIMITS, pdfChildArgs } from "../src/document-parsers.js";

/**
 * No private book bytes. Different from the 151.5 MB unreferenced-stream
 * source test: EVERY one of 271 pages paints its own ~552 KB raster XObject.
 * This is a PDF.js content/graph pressure test, NOT an OCR accuracy claim.
 */
const TOTAL_BYTES = 151_495_200;
const PAGE_COUNT = 271;
const WIDTH = 800;
const HEIGHT = 690;
const IMAGE_BYTES = WIDTH * HEIGHT;
const MAX_RSS_KIB = 512 * 1024;
const MAX_WALL_MS = 150_000;

async function writeImageBook(path: string) {
  const pagesId = 2;
  const imageBase = 3 + PAGE_COUNT * 2;
  const padId = imageBase + PAGE_COUNT;
  const offsets = new Array<number>(padId + 1).fill(0);
  const file = await open(path, "wx", 0o600);
  let cursor = 0;
  async function write(part: string | Uint8Array) {
    await file.writeFile(part);
    cursor += typeof part === "string" ? Buffer.byteLength(part) : part.byteLength;
  }
  async function object(id: number, body: string) {
    offsets[id] = cursor;
    await write(id + " 0 obj\n" + body + "\nendobj\n");
  }

  try {
    await write("%PDF-1.4\n");
    await object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    await object(pagesId, "<< /Type /Pages /Kids [" +
      Array.from({ length: PAGE_COUNT }, (_, i) => (i + 3) + " 0 R").join(" ") +
      "] /Count " + PAGE_COUNT + " >>");
    for (let i = 0; i < PAGE_COUNT; i++) {
      const contentId = 3 + PAGE_COUNT + i;
      const imageId = imageBase + i;
      await object(3 + i, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        "/Resources << /XObject << /Im0 " + imageId + " 0 R >> >> " +
        "/Contents " + contentId + " 0 R >>");
    }
    for (let i = 0; i < PAGE_COUNT; i++) {
      const stream = "q\n500 0 0 430 50 180 cm\n/Im0 Do\nQ\n";
      await object(3 + PAGE_COUNT + i,
        "<< /Length " + Buffer.byteLength(stream) + " >>\nstream\n" + stream + "endstream");
    }
    const image = Buffer.alloc(IMAGE_BYTES);
    for (let i = 0; i < image.length; i++) image[i] = (i * 13 + (i >> 8)) & 255;
    for (let i = 0; i < PAGE_COUNT; i++) {
      const imageId = imageBase + i;
      offsets[imageId] = cursor;
      await write(imageId + " 0 obj\n<< /Type /XObject /Subtype /Image " +
        "/Width " + WIDTH + " /Height " + HEIGHT +
        " /ColorSpace /DeviceGray /BitsPerComponent 8 " +
        "/Length " + IMAGE_BYTES + " >>\nstream\n");
      await write(image);
      await write("\nendstream\nendobj\n");
    }

    offsets[padId] = cursor;
    const xref = [
      "xref", "0 " + (padId + 1), "0000000000 65535 f ",
      ...offsets.slice(1).map(pos => String(pos).padStart(10, "0") + " 00000 n "),
      "trailer", "<< /Size " + (padId + 1) + " /Root 1 0 R >>",
      "startxref",
    ].join("\n");
    const padHead = (n: number) => padId + " 0 obj\n<< /Length " + n + " >>\nstream\n";
    const padTail = "\nendstream\nendobj\n";
    let extra = TOTAL_BYTES - cursor - Buffer.byteLength(padHead(0) + padTail + xref + "\n0\n%%EOF\n");
    for (let i = 0; i < 12; i++) {
      const xrefPosition = cursor + Buffer.byteLength(padHead(extra)) + extra + Buffer.byteLength(padTail);
      const trailer = xref + "\n" + xrefPosition + "\n%%EOF\n";
      const next = TOTAL_BYTES - cursor - Buffer.byteLength(padHead(extra) + padTail + trailer);
      if (next === extra) break;
      extra = next;
    }
    const xrefPosition = cursor + Buffer.byteLength(padHead(extra)) + extra + Buffer.byteLength(padTail);
    const trailer = xref + "\n" + xrefPosition + "\n%%EOF\n";
    if (extra < 0 || xrefPosition + Buffer.byteLength(trailer) !== TOTAL_BYTES)
      throw new Error("SYNTHETIC_REFERENCED_IMAGE_PDF_SIZE_INVALID");
    await write(padHead(extra));
    const spaces = Buffer.alloc(1024 * 1024, 0x20);
    for (let remaining = extra; remaining > 0;) {
      const amount = Math.min(remaining, spaces.length);
      await write(spaces.subarray(0, amount));
      remaining -= amount;
    }
    await write(padTail);
    await write(trailer);
    expect(cursor).toBe(TOTAL_BYTES);
    expect((await file.stat()).size).toBe(TOTAL_BYTES);
  } finally { await file.close(); }
}

async function measureImageParse(path: string) {
  if (process.platform !== "linux") throw new Error("LINUX_RSS_EVIDENCE_REQUIRED");
  const child = spawn(process.execPath, pdfChildArgs(path, {
    ...DEFAULT_PARSER_LIMITS, pdfMemoryMb: 128,
    maxPdfPages: PAGE_COUNT, maxPdfOutputChars: 100,
  }), { stdio: ["ignore", "pipe", "pipe"] });
  if (!child.pid) throw new Error("PDF_PARSER_NOT_STARTED");
  let out = "", err = "", highRss = 0, samples = 0, exceeded = false, timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, MAX_WALL_MS);
  const poll = setInterval(() => {
    void readFile("/proc/" + child.pid + "/status", "utf8").then(content => {
      const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(content);
      if (!match) return;
      samples++;
      highRss = Math.max(highRss, Number(match[1]));
      if (highRss > MAX_RSS_KIB) { exceeded = true; child.kill("SIGKILL"); }
    }).catch(() => {});
  }, 25);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (part: string) => {
    out += part;
    if (out.length > 300_000) { exceeded = true; child.kill("SIGKILL"); }
  });
  child.stderr.on("data", (part: string) => {
    err += part;
    if (err.length > 100_000) { exceeded = true; child.kill("SIGKILL"); }
  });
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    const message = "peakRssMiB=" + (highRss / 1024).toFixed(1) + " samples=" +
      samples + " outBytes=" + out.length + " stderrTail=" + err.slice(-1200);
    process.stdout.write("PDF_REFERENCED_IMAGE_SYNTHETIC_DIAGNOSTIC=" + message + "\n");
    expect(timedOut, "referenced-image parse timed out: " + message).toBe(false);
    expect(exceeded, "referenced-image parser exceeded RSS or IPC cap: " + message).toBe(false);
    expect(samples).toBeGreaterThan(0);
    expect(highRss).toBeLessThanOrEqual(MAX_RSS_KIB);
    expect(result, message).toEqual({ code: 0, signal: null });
    const rows = out.trim().split("\n").map(line => JSON.parse(line) as {
      type: string; pages?: number; physicalPageIndex?: number;
      evidence?: { imageCount: number }; text?: string;
    });
    expect(rows[0]).toMatchObject({ type: "meta", pages: PAGE_COUNT });
    expect(rows.at(-1)?.type).toBe("done");
    const pages = rows.filter(row => row.type === "page");
    expect(pages).toHaveLength(PAGE_COUNT);
    for (let i = 0; i < PAGE_COUNT; i++) {
      expect(pages[i]?.physicalPageIndex).toBe(i);
      expect(pages[i]?.text).toBe("");
      expect(pages[i]?.evidence?.imageCount).toBeGreaterThan(0);
    }
    process.stdout.write("PDF_REFERENCED_IMAGE_SYNTHETIC_PAGES=" + pages.length + "\n");
    process.stdout.write("PDF_REFERENCED_IMAGE_SYNTHETIC_PEAK_RSS_MIB=" +
      (highRss / 1024).toFixed(1) + "\n");
  } finally {
    clearTimeout(timeout);
    clearInterval(poll);
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
}

describe.skipIf(process.env.PDF_REFERENCED_IMAGE_PROOF !== "true")(
  "151.5 MB, 271-page PDF with painted raster image XObjects (synthetic)",
  () => {
    it("proves page-level referenced-image evidence under parser RSS and time limits", async () => {
      if (process.env.NODE_ENV !== "test" || process.platform !== "linux")
        throw new Error("SYNTHETIC_PDF_STRESS_ISOLATION_REQUIRED");
      const dir = await mkdtemp(join(tmpdir(), "pdf-images-stress-"));
      try {
        const path = join(dir, "271-scanned-synthetic.pdf");
        await writeImageBook(path);
        await measureImageParse(path);
      } finally { await rm(dir, { recursive: true, force: true }); }
    }, MAX_WALL_MS + 35_000);
  },
);
