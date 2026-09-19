import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

export const TOOL_ROOT = join(HERE, "..");

export function pdfjsChildPath(): string {
  return join(TOOL_ROOT, "adapters", "pdfjs-child.ts");
}

/** Absolute file URL of the installed tsx ESM loader (spawn cwd may be anywhere). */
export function pdfjsLoaderImportUrl(): string {
  return pathToFileURL(join(TOOL_ROOT, "node_modules", "tsx", "dist", "loader.mjs")).href;
}

export function liteparseChildPath(): string {
  return join(TOOL_ROOT, "adapters", "liteparse-child.mjs");
}

export function doclingRunnerPath(): string {
  return join(TOOL_ROOT, "python", "docling_runner.py");
}
