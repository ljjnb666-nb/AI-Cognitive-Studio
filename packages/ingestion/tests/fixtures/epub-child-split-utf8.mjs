import process from "node:process";

const parsed = {
  parser: { name: "builtin-epub", version: "epub-parser-v2" },
  pages: [{
    physicalPageIndex: null,
    blocks: [{
      kind: "PARAGRAPH",
      text: "中文",
      locator: { kind: "epub", spineIndex: 0, href: "OPS/a.xhtml", fragmentId: null, elementPath: "/html[1]/body[1]/p[1]" },
      provenance: { sourceMethod: "STRUCTURED_MARKUP", parserName: "builtin-epub", parserVersion: "epub-parser-v2" },
    }],
  }],
  qualityWarnings: [],
  formatMetadata: {
    kind: "epub",
    epubVersion: "3.0",
    packagePath: "OPS/book.opf",
    renditionLayout: "REFLOWABLE",
    spineItemCount: 1,
    navigationSource: "NONE",
    navigation: [],
    dcTitle: null,
    dcLanguage: null,
    dcIdentifier: null,
  },
};

const payload = Buffer.from(JSON.stringify({ type: "result", parsed }) + "\n", "utf8");
const marker = Buffer.from("中", "utf8");
const at = payload.indexOf(marker);
if (at < 0) process.exit(2);
process.stdout.write(payload.subarray(0, at + 1));
setTimeout(() => process.stdout.write(payload.subarray(at + 1)), 5);
