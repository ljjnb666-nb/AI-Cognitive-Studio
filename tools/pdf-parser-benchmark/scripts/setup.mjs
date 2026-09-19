import { existsSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One-time environment setup for the pdfjs baseline adapter.
 *
 * The production parser child (packages/ingestion/src/pdf-parser-child.mjs)
 * resolves `pdfjs-dist` by walking up from packages/ingestion — a fresh
 * worktree has no root node_modules, so we create a junction to this tool's
 * node_modules (which pins pdfjs-dist 6.2.108, the exact production version).
 * The worktree root .gitignore already excludes node_modules/.
 */
const toolRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const worktreeRoot = resolve(join(toolRoot, "..", ".."));
const rootModules = join(worktreeRoot, "node_modules");
const toolModules = join(toolRoot, "node_modules");

if (!existsSync(toolModules)) {
  console.error("tool node_modules missing — run `npm install` first");
  process.exit(1);
}

try {
  const existing = existsSync(rootModules) ? readlinkSync(rootModules) : null;
  if (existing) {
    console.log(`junction already present: ${rootModules} -> ${existing}`);
  } else if (existsSync(rootModules)) {
    console.error(`refusing to touch non-junction directory: ${rootModules}`);
    process.exit(1);
  } else {
    symlinkSync(toolModules, rootModules, "junction");
    console.log(`created junction: ${rootModules} -> ${toolModules}`);
  }
} catch (error) {
  console.error(`junction setup failed: ${error}`);
  process.exit(1);
}
