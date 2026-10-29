import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MineruStandardManifest } from "./mineru-standard-admission.js";

/** Code-reviewed inventory for registry.MINERU_4_MODELS_ONNX (13 named
 * resources) + GGUF.main/mmproj + its required empty completion sentinel. No weights or machine paths are shipped.
 * This digest is a release allowlist, never derived from an operator file. */
export const MINERU_MODEL_REVISION = "mineru-4.0.3-onnx-llamacpp-q8-v1";
export const APPROVED_MINERU_MANIFEST_SHA256 = "3382d142ef28eeeda138fd13786ec41e591007c852aca1487b424850f8c179ad";
export const APPROVED_MINERU_MANIFEST_PATH = new URL("./manifests/mineru-4.0.3-onnx-llamacpp-v1.json", import.meta.url);
export function approvedManifestText(): string {
  const raw=readFileSync(APPROVED_MINERU_MANIFEST_PATH,"utf8");
  if (createHash("sha256").update(raw).digest("hex")!==APPROVED_MINERU_MANIFEST_SHA256) throw new Error("OCR_MODEL_ALLOWLIST_CORRUPTED");
  return raw;
}
export function isApprovedMineruManifest(manifest: MineruStandardManifest): boolean {
  const approved=JSON.parse(approvedManifestText()) as MineruStandardManifest;
  if(manifest.schemaVersion!==approved.schemaVersion || manifest.mineruVersion!==approved.mineruVersion || manifest.files.length!==approved.files.length) return false;
  const entries=[...manifest.files].sort((a,b)=>a.path.localeCompare(b.path,"en"));
  return approved.files.every(file=>entries.some(entry=>entry.path===file.path && entry.sizeBytes===file.sizeBytes && entry.sha256===file.sha256));
}
