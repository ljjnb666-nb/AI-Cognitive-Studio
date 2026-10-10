import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import {
  DRAFT_SCHEMA, FIXTURES, createDraft, makeEmptyBlock,
  parseDraft, buildGroundTruth, assessDraft, AnnotationError,
} from "../annotation/workspace.mjs";
import { startAnnotationServer } from "../annotation/server.mjs";
import { parseGroundTruth } from "../src/ground-truth.ts";

function fillSynthetic(id = "RB-PDF-11") {
  const d = createDraft(id);
  d.pageSize = { width: 595.28, height: 841.89 };
  d.markersText = "章节甲\n末尾文字";
  d.pages[0].blocks = [
    { ...makeEmptyBlock("heading"), text: "章节甲" },
    { ...makeEmptyBlock("paragraph"), text: "第一段正文测试。" },
    { ...makeEmptyBlock("header"), text: "重复页眉" },
  ];
  d.pages[1].ocrRequired = true;
  d.pages[1].ocrPhrasesText = "项目一";
  d.pages[1].blocks = [
    { ...makeEmptyBlock("list_item"), text: "项目一", ordered: true },
    { ...makeEmptyBlock("list_item"), text: "项目二", ordered: true },
    { ...makeEmptyBlock("table"), text: "演示表", tableTsv: "名称\t数值\n甲\t1" },
    { ...makeEmptyBlock("figure"), text: "" },
    { ...makeEmptyBlock("caption"), text: "图注释" },
  ];
  d.pages[2].blocks = [
    { ...makeEmptyBlock("formula"), text: "a+b=c", display: true },
    { ...makeEmptyBlock("paragraph"), text: "末尾文字" },
    { ...makeEmptyBlock("footer"), text: "重复页脚" },
  ];
  return d;
}
function blockCode(d, expected) {
  expect(() => buildGroundTruth(d)).toThrowError(AnnotationError);
  try { buildGroundTruth(d); }
  catch (error) { expect(error.code).toBe(expected); }
}

describe("offline human GT authoring — purely synthetic", () => {
  it("pins the 3 real-book fixture IDs and immutable original page mappings", () => {
    expect(Object.keys(FIXTURES)).toEqual(["RB-PDF-11", "RB-PDF-12", "RB-PDF-13"]);
    expect(createDraft("RB-PDF-12").pages.map(p => p.originalPhysicalPage)).toEqual([73, 145, 261]);
    expect(createDraft("RB-PDF-13").pages.map(p => p.originalPhysicalPage)).toEqual([51, 127, 379]);
    expect(() => createDraft("RB-PDF-14")).toThrow("FIXTURE_NOT_ALLOWLISTED");
  });
  it("exports a benchmark Zod-compatible GT with unique B IDs, page-relative ordering and structural fields", () => {
    const gt = buildGroundTruth(fillSynthetic());
    expect(parseGroundTruth(gt)).toEqual(gt);
    expect(gt.fixtureId).toBe("RB-PDF-11");
    expect(gt.pages).toBe(3);
    expect(gt.generator).toBe("human-curated-from-original");
    expect(gt.normalizationPolicy).toBe("NFKC + remove whitespace");
    expect(gt.blocks.map(b => b.id)).toEqual(Array.from({ length: gt.blocks.length }, (_, i) => "B" + (i + 1)));
    expect(gt.blocks.map(b => b.page)).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2]);
    expect(gt.text).toBe("章节甲\n第一段正文测试。\n项目一\n项目二\n演示表\n名称 数值\n甲 1\n图注释\na+b=c\n末尾文字");
    expect(gt.ocrRequiredPages).toEqual([1]);
    expect(gt.ocrKeyPhrases).toEqual([{ page: 1, phrase: "项目一" }]);
    expect(gt.tables).toEqual([{ page: 1, rows: 2, cols: 2, cells: [["名称", "数值"], ["甲", "1"]] }]);
    expect(gt.lists).toEqual([{ page: 1, ordered: true, items: ["项目一", "项目二"] }]);
    expect(gt.formulas).toEqual([{ page: 2, display: true, text: "a+b=c" }]);
    expect(gt.blocks.filter(b => b.role === "table").map(b => b.text)).toEqual(["演示表\n名称 数值\n甲 1"]);
    expect(gt.headings).toEqual([{ page: 0, text: "章节甲" }]);
    expect(gt.noise).toEqual([{ kind: "header", text: "重复页眉" }, { kind: "footer", text: "重复页脚" }]);
  });
  it("never invents human review, a score, or accepted quality", () => {
    const d = fillSynthetic(), gt = buildGroundTruth(d), state = assessDraft(d);
    expect(state.status).toBe("READY_FOR_INDEPENDENT_REVIEW");
    expect(state.message).toMatch(/尚未经原书人工复核/);
    expect(gt).not.toHaveProperty("reviewers");
    expect(gt).not.toHaveProperty("quality");
    expect(gt).not.toHaveProperty("qualityStatus");
    expect(assessDraft(createDraft("RB-PDF-11")).status).toBe("DRAFT_INCOMPLETE");
  });
  it("validates source page lineage and rejects edited physical-page mapping", () => {
    const d = fillSynthetic();
    d.pages[1].originalPhysicalPage = 999;
    expect(() => parseDraft(d)).toThrow("DRAFT_PAGE_LINEAGE_INVALID");
  });
  it("rejects malformed draft, extra page and unsafe fixture ID", () => {
    const d = fillSynthetic();
    d.pages.push({ index: 3, originalPhysicalPage: 5, ocrRequired: false, ocrPhrasesText: "", blocks: [] });
    expect(() => parseDraft(d)).toThrow("DRAFT_PAGE_COUNT_INVALID");
    expect(() => parseDraft({ ...fillSynthetic(), fixtureId: "../../escape" })).toThrow("DRAFT_SCHEMA_INVALID");
    expect(() => parseDraft({ schema: DRAFT_SCHEMA, fixtureId: "RB-PDF-11", pages: [], pageSize: null })).toThrow("PAGE_SIZE_INVALID");
  });
  it("rejects any missing-page annotation and missing key markers", () => {
    const d = fillSynthetic();
    d.pages[1].blocks = [];
    blockCode(d, "GROUND_TRUTH_PAGE_CONTENT_MISSING");
    const noMarkers = fillSynthetic(); noMarkers.markersText = "";
    blockCode(noMarkers, "KEY_MARKERS_REQUIRED");
  });
  it("blocks marker/ocr transcript contradictions without filling missing information", () => {
    const badMarker = fillSynthetic();
    badMarker.markersText = "我并未对照原书";
    blockCode(badMarker, "GROUND_TRUTH_MARKER_CONFLICT");
    const badOCR = fillSynthetic();
    badOCR.pages[1].ocrPhrasesText = "文本不存在";
    blockCode(badOCR, "OCR_PHRASE_NOT_IN_CANONICAL_TEXT");
    const wrongOCR = fillSynthetic();
    wrongOCR.pages[1].ocrRequired = false;
    blockCode(wrongOCR, "OCR_PAGE_NOT_SELECTED");
  });
  it("preserves genuinely empty first and last table cells (no TSV trimming)", () => {
    const d = fillSynthetic();
    d.pages[1].blocks[2].tableTsv = "\tB\nA\t\n";
    expect(buildGroundTruth(d).tables[0].cells).toEqual([["", "B"], ["A", ""]]);
  });
  it("rejects ragged TSV and empty formula/list-item fields", () => {
    const d = fillSynthetic();
    d.pages[1].blocks[2].tableTsv = "A\tB\nC";
    blockCode(d, "TABLE_GRID_NOT_RECTANGULAR");
    const noFormula = fillSynthetic();
    noFormula.pages[2].blocks[0].text = "";
    blockCode(noFormula, "FORMULA_TEXT_REQUIRED");
    const noItem = fillSynthetic();
    noItem.pages[1].blocks[0].text = "";
    blockCode(noItem, "LIST_ITEM_TEXT_REQUIRED");
  });
  it("rejects oversized and invalid fields before rendering/import", () => {
    const d = fillSynthetic();
    d.pages[0].blocks[0].text = "x".repeat(100001);
    expect(() => parseDraft(d)).toThrow("DRAFT_FIELD_INVALID");
    const d2 = fillSynthetic();
    d2.pages[0].blocks[0].column = -1;
    expect(() => parseDraft(d2)).toThrow("BLOCK_COLUMN_INVALID");
  });
  it("drops unknown and prototype-like fields on import, then retains only declared editor keys", () => {
    const d = JSON.parse(JSON.stringify(fillSynthetic()));
    d.malicious = "not-kept";
    d.pages[0].blocks[0].__proto__ = { path: "../../other" };
    const parsed = parseDraft(d);
    expect(parsed).not.toHaveProperty("malicious");
    expect(parsed.pages[0].blocks[0]).not.toHaveProperty("path");
    expect(Object.keys(parsed.pages[0].blocks[0])).toEqual(["role", "text", "column", "ordered", "display", "tableTsv"]);
  });
});
describe("local static server — no real private data", () => {
  it("binds loopback, serves only the UI assets and denies API/data retrieval", async () => {
    const app = await startAnnotationServer();
    try {
      expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const index = await fetch(app.url);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-security-policy")).toContain("connect-src 'none'");
      expect(index.headers.get("cache-control")).toBe("no-store");
      const html = await index.text();
      expect(html).toContain("Ground Truth 人工标注台");
      const source = await fetch(new URL("workspace.mjs", app.url));
      expect(source.status).toBe(200);
      expect(await source.text()).toContain("export function buildGroundTruth");
      for (const uri of ["fixtures/fixtures.manifest.json", "README.md", ".git/config", "C%3A/private.pdf", "robots.txt"]) {
        expect((await fetch(new URL(uri, app.url))).status).toBe(404);
      }
      expect((await fetch(app.url, { method: "POST", body: "private text" })).status).toBe(404);
      // Undici's fetch() may replace a caller-supplied Host with the URL host;
      // send raw HTTP to assert our real DNS-rebinding guard.
      const wrongHostStatus = await new Promise((resolve, reject) => {
        const destination = new URL(app.url);
        const req = httpRequest({
          hostname: destination.hostname, port: Number(destination.port),
          path: "/", method: "GET", headers: { Host: "evil.example.test" },
        }, response => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        });
        req.once("error", reject);
        req.end();
      });
      expect(wrongHostStatus).toBe(403);
    } finally {
      await app.close();
    }
  });
  it("does not use browser persistent storage or outbound network APIs", async () => {
    const script = await readFile(new URL("../annotation/app.mjs", import.meta.url), "utf8");
    const html = await readFile(new URL("../annotation/index.html", import.meta.url), "utf8");
    for (const forbidden of ["fetch(", "XMLHttpRequest(", "new WebSocket(", "localStorage.", "sessionStorage.", "serviceWorker.register(", "sendBeacon("]) {
      // Comments may contain text names; validate executable invocation strings.
      expect(script).not.toContain(forbidden);
    }
    expect(html).toContain("script type=\"module\" src=\"./app.mjs\"");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/https?:\/\/[^\s"']+/u);
  });
});
