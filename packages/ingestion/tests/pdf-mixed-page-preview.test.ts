import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createCanvas, loadImage } from "@napi-rs/canvas";

import { PassThrough } from "node:stream";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARSER_LIMITS, extractNativePdf } from "../src/document-parsers.js";
import { renderPdfMixedPageSourcePreviews, PDF_MIXED_PREVIEW_AUTHORITY } from "../src/pdf-mixed-page-preview.js";

const testPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function pdf(mixed: boolean): Promise<Uint8Array> {
  const document = new PDFDocument({ autoFirstPage: false });
  const stream = new PassThrough(), chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Uint8Array>((resolve) =>
    stream.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks)))));
  document.pipe(stream);
  document.addPage();
  document.text("A paragraph of canonical native source text",50,50);
  if (mixed) document.image(testPng,70,110,{width:90,height:60});
  document.addPage();
  document.text("A second native only page",50,50);
  document.end();
  return await done;
}

describe("opt-in mixed PDF page image preview — real isolated child", () => {
  it("renders a real source-bound mixed PDF into PNG without changing publication or routing", async () => {
    const input = await pdf(true);
    const previous = await extractNativePdf(input,DEFAULT_PARSER_LIMITS);
    const previousPlan = JSON.stringify(previous.routingPlan);
    expect(previous.routingPlan.pages.map(p=>p.route)).toEqual(["NATIVE_TEXT","NATIVE_TEXT"]);
    const r = await renderPdfMixedPageSourcePreviews(input,DEFAULT_PARSER_LIMITS,{
      enabled:true,maxPreviewPages:2,maxPixels:4_000_000,timeoutMs:45_000,
    });
    expect(r).toMatchObject({
      pageCount:2,mixedPageCount:1,previewCount:1,
      productionRoutingChanged:false,goldApproved:false,
    });
    const item = r.previews[0]!;
    expect(item).toMatchObject({
      authority:PDF_MIXED_PREVIEW_AUTHORITY,physicalPageIndex:0,
      sourceSha256:digest(input),figureSemantics:"UNVERIFIED",
      canonicalTextChanged:false,
    });
    expect(item.width*item.height).toBeGreaterThan(100_000);
    expect(item.pngBytes.subarray(0,8)).toEqual(
      new Uint8Array([137,80,78,71,13,10,26,10]));
    expect(item.pngSha256).toBe(digest(item.pngBytes));
    expect(JSON.stringify(previous.routingPlan)).toBe(previousPlan);
  }, 60_000);

  it("does not manufacture an image for an ordinary native-text PDF", async () => {
    const r = await renderPdfMixedPageSourcePreviews(await pdf(false),DEFAULT_PARSER_LIMITS,{enabled:true});
    expect(r.mixedPageCount).toBe(0);
    expect(r.previewCount).toBe(0);
    expect(r.previews).toEqual([]);
  },30_000);

  it("fail-closes on disabled/oversized preview settings before spawning a child", async () => {
    const data = await pdf(true);
    await expect(renderPdfMixedPageSourcePreviews(data,DEFAULT_PARSER_LIMITS,{
      enabled:false as true,
    })).rejects.toThrow("PDF_MIXED_PREVIEW_OPTIONS_INVALID");
    await expect(renderPdfMixedPageSourcePreviews(data,DEFAULT_PARSER_LIMITS,{
      enabled:true,maxPixels:50,
    })).rejects.toThrow("PDF_MIXED_PREVIEW_OPTIONS_INVALID");
    await expect(renderPdfMixedPageSourcePreviews(data,DEFAULT_PARSER_LIMITS,{
      enabled:true,maxPreviewPages:40,
    })).rejects.toThrow("PDF_MIXED_PREVIEW_OPTIONS_INVALID");
  });

  it("rejects a real rendered mixed page exceeding its hard pixel budget", async () => {
    const input = await pdf(true);
    await expect(renderPdfMixedPageSourcePreviews(input,DEFAULT_PARSER_LIMITS,{
      enabled:true,maxPixels:100_000,timeoutMs:45_000,
    })).rejects.toThrow("PDF_MIXED_PREVIEW_CHILD_REJECTED");
  },60_000);
});

// Public, synthetic JBIG2 regression sample (NOT a user's book or a private
// benchmark). Provenance: mozilla/pdf.js test/pdfs/bitmap-composite-and-xnor.pdf
// blob 2ff5a471b583ee4c0bfbccf76e54ec082d3903dc; PDF.js repository Apache-2.0.
// Embedding it here avoids network, manual fixture setup, and public book data.
const jbig2Fixture = Buffer.from(
  "JVBERi0xLjQKJbW2CgoxIDAgb2JqCjw8CiAgL1R5cGUgL0NhdGFsb2cKICAvUGFnZXMgMiAwIFIKPj4KZW5kb2JqCg" +
  "oyIDAgb2JqCjw8CiAgL1R5cGUgL1BhZ2VzCiAgL0tpZHMgWzMgMCBSXQogIC9Db3VudCAxCj4+CmVuZG9iagoKMyAw" +
  "IG9iago8PAogIC9UeXBlIC9QYWdlCiAgL1BhcmVudCAyIDAgUgogIC9NZWRpYUJveCBbMCAwIDM5OSA0MDBdCiAgL0" +
  "NvbnRlbnRzIDQgMCBSCiAgL1Jlc291cmNlcyA8PAogICAgL1hPYmplY3QgPDwKICAgICAgL0ltIDUgMCBSCiAgICA+" +
  "PgogID4+Cj4+CmVuZG9iagoKNCAwIG9iago8PC9MZW5ndGggMjU+PgpzdHJlYW0KMzk5IDAgMCA0MDAgMCAwIGNtCi" +
  "9JbSBEbwplbmRzdHJlYW0KZW5kb2JqCgo1IDAgb2JqCjw8CiAgL0xlbmd0aCA1NzYKICAvVHlwZSAvWE9iamVjdAog" +
  "IC9TdWJ0eXBlIC9JbWFnZQogIC9XaWR0aCAzOTkKICAvSGVpZ2h0IDQwMAogIC9Db2xvclNwYWNlIC9EZXZpY2VHcm" +
  "F5CiAgL0ZpbHRlciAvSkJJRzJEZWNvZGUKICAvQml0c1BlckNvbXBvbmVudCAxCj4+CnN0cmVhbQoAAAAAMAABAAAA" +
  "EwAAAY8AAAGQAAAAAAAAAABEAAAAAAABJwABAAAAUQAAAI0AAAGQAAAAAAAAAAABAAP//f8C/v7+q/KQz72poi96sI" +
  "jGOptzSa2oUUUv8O7RwanWMxfLIla6J507OyhHBje2BzatKtN3Niro/aL/rAAAAAInAAEAAABRAAAAjQAAAZAAAAAA" +
  "AAAAAAEAA//9/wL+/v6r8pDPvamiL3qwiMY6m3NJrahRRS/w7tHBqdYzF8siVronnTs7KEcGN7YHNq0q03c2Kuj9ov" +
  "+sAAAAAycAAQAAAN0AAAECAAABkAAAAI0AAAAAAwAD//3/Av7+/qvzov9e3P30ERHAi1RG1ck2ftaupJy2yQheIM1X" +
  "i0lNre2bjqc0LiwelR2f/3GgjfUJ0f9jqYHPkplCFS9EaqydzqoElNEvYfug/3k9pDD1733wH/Z/5a5/TRrlBVASNm" +
  "79xfZ73pBBXNXubXikp9+TjpQuwLhOZchW+KuXfNBf0kBj/z4u/Ds9pTH+HSiWav8qB3R7i7VeaEz9vvSnRemUAf4d" +
  "6X3M+t4UMlYMNJu2Z79CQ7o/saapWo2HUD0Dxn//rAAAAAQnAAEAAAA2AAAAFwAAABcAAAA8AAAAvgMAA//9/wL+/v" +
  "5yxqdu7n3RbnYehijGs8A8+G++Yy/44r73f/+sAAAABScAAQAAADYAAAAXAAAAFwAAADwAAAC+AwAD//3/Av7+/nLG" +
  "p27ufdFudh6GKMazwDz4b75jL/jivvd//6wKZW5kc3RyZWFtCmVuZG9iagoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NT" +
  "UzNiBmIAowMDAwMDAwMDE0IDAwMDAwIG4gCjAwMDAwMDAwNjggMDAwMDAgbiAKMDAwMDAwMDEzMiAwMDAwMCBuIAow" +
  "MDAwMDAwMjg4IDAwMDAwIG4gCjAwMDAwMDAzNjIgMDAwMDAgbiAKCnRyYWlsZXIKPDwKICAvU2l6ZSA2CiAgL1Jvb3" +
  "QgMSAwIFIKPj4Kc3RhcnR4cmVmCjExMjUKJSVFT0YK","base64",
);
const execFileAsync = promisify(execFile);

it("decodes a real JBIG2 image offline with packaged WASM, never accepting a white preview", async () => {
  expect(jbig2Fixture.subarray(0,8).toString("ascii")).toContain("%PDF");
  expect(jbig2Fixture.includes(Buffer.from("/JBIG2Decode"))).toBe(true);
  const packageUrl = import.meta.resolve("pdfjs-dist/package.json");
  const wasmPath = fileURLToPath(new URL("./wasm/jbig2.wasm",packageUrl));
  const wasmBytes = await readFile(wasmPath);
  expect(wasmBytes.length).toBeGreaterThan(1_024);
  expect(wasmBytes.subarray(0,4)).toEqual(Buffer.from([0,97,115,109]));

  const dir = await mkdtemp(join(tmpdir(),"acs-jbig2-public-smoke-"));
  try {
    const source = join(dir,"source.pdf"), output = join(dir,"preview.png");
    await writeFile(source,jbig2Fixture,{flag:"wx",mode:0o600});
    const child = fileURLToPath(new URL("../src/pdf-mixed-page-render-child.mjs",import.meta.url));
    const { stdout } = await execFileAsync(process.execPath,[
      "--max-old-space-size=384",child,source,"0",output,"4000000",
    ],{timeout:45000,maxBuffer:4096,env:{
      ...process.env,HTTP_PROXY:"http://127.0.0.1:1",HTTPS_PROXY:"http://127.0.0.1:1",ALL_PROXY:"http://127.0.0.1:1",
    }});
    const metadata: unknown = JSON.parse(stdout.trim());
    expect(metadata).toMatchObject({status:"PREVIEW_ONLY",schemaVersion:1,physicalPageIndex:0});
    const bytes = await readFile(output);
    const image = await loadImage(bytes);
    expect(image.width * image.height).toBeGreaterThan(100_000);
    const canvas = createCanvas(image.width,image.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image,0,0);
    const pixels = ctx.getImageData(0,0,image.width,image.height).data;
    let nonWhite = 0;
    for(let i=0;i<pixels.length;i+=4){
      if(pixels[i]! < 240 || pixels[i+1]! < 240 || pixels[i+2]! < 240) nonWhite++;
    }
    expect(nonWhite).toBeGreaterThan(100);
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
},60000);
