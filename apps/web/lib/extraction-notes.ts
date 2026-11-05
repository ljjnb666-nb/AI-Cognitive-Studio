import { parseExtractionQualityMetadata } from "@ai-cognitive/domain";

/** Explain persisted parser observations; never infer clean/full extraction from success alone. */
export function extractionNotes(extraction: { qualityMetadata?: unknown; formatMetadata?: unknown } | null | undefined) {
  if (!extraction) return [];
  let warnings: string[] = [];
  try { warnings = parseExtractionQualityMetadata(extraction.qualityMetadata).warnings; } catch { /* Legacy rows have no quality metadata. */ }
  const notes: string[] = [];
  if (warnings.includes("EPUB_COMPATIBILITY_APPLIED")) notes.push(`导入时已自动兼容处理格式差异，原文件未改动。`);
  if (warnings.includes("PARTIAL_EXTRACTION")) notes.push("部分内容未提取，请对照原书核对完整性。");
  if (warnings.includes("EPUB_NAVIGATION_DEGRADED")) notes.push("书内目录未能完整读取，正文仍可分段查看。");
  if (warnings.includes("EPUB_FIXED_LAYOUT")) notes.push("这是固定版式电子书，原文预览可能无法完整还原版面。");
  return notes;
}
