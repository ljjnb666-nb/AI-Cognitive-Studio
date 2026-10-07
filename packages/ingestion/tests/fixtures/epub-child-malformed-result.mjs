import process from "node:process";
process.stdout.write(JSON.stringify({
  type: "result",
  parsed: { parser: { name: "builtin-epub", version: "epub-parser-v2" }, pages: [] },
}) + "\n");
