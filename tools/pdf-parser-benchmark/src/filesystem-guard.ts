import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Filesystem allowlist (Phase 1 spec #28/#30).
 * Parser inputs may only come from the fixtures allowlist; outputs and temp
 * may only live under the benchmark data root or the benchmark worktree.
 */

export const DATA_ROOT = process.env.BENCH_DATA_ROOT ?? "D:\\ai-cognitive-pdf-benchmark-data";
export const WORKTREE_ROOT =
  process.env.BENCH_WORKTREE_ROOT ?? "C:\\Users\\LJJ2004\\所有项目\\90_Worktrees\\AI-Cognitive-Studio-pdf-parser-benchmark";
export const FIXTURES_ROOT = join(DATA_ROOT, "fixtures");
export const OUTPUTS_ROOT = join(DATA_ROOT, "outputs");
export const TEMP_ROOT = join(DATA_ROOT, "temp");
export const REPORTS_ROOT = join(DATA_ROOT, "reports");
export const MODELS_ROOT = join(DATA_ROOT, "models");
export const CACHE_ROOT = join(DATA_ROOT, "cache");

export const ALLOWED_ROOTS = [DATA_ROOT, WORKTREE_ROOT];

export class InvalidOutputPathError extends Error {
  constructor(message: string) {
    super(`INVALID_OUTPUT_PATH: ${message}`);
  }
}

export function assertInside(root: string, candidate: string, label = "path"): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) {
    throw new InvalidOutputPathError(`${label} escapes allowed root: ${resolved}`);
  }
  return resolved;
}

export function assertAllowed(candidate: string, label = "path"): string {
  let lastError: InvalidOutputPathError | null = null;
  for (const root of ALLOWED_ROOTS) {
    try {
      return assertInside(root, candidate, label);
    } catch (error) {
      lastError = error as InvalidOutputPathError;
    }
  }
  throw lastError ?? new InvalidOutputPathError(`${candidate} not allowed`);
}

/** Fixture inputs: must be inside the fixtures allowlist and a .pdf file. */
export function assertFixturePath(candidate: string): string {
  const resolved = assertInside(FIXTURES_ROOT, candidate, "fixture");
  if (!resolved.toLowerCase().endsWith(".pdf")) throw new InvalidOutputPathError(`fixture must be .pdf: ${resolved}`);
  return resolved;
}

/** Normalized block text must be bounded; parser output is untrusted (#29). */
export function validateNormalizedPayloadShape(payload: { pages?: Array<{ blocks?: unknown[] }> }): void {
  const pages = payload.pages;
  if (!Array.isArray(pages)) throw new InvalidOutputPathError("normalized payload missing pages array");
  if (pages.length > 5_000) throw new InvalidOutputPathError(`too many pages: ${pages.length}`);
  for (const page of pages) {
    if (!Array.isArray(page.blocks)) throw new InvalidOutputPathError("page missing blocks array");
    if ((page.blocks as unknown[]).length > 20_000) throw new InvalidOutputPathError("too many blocks on one page");
  }
}

export function isInsideDataRoot(candidate: string): boolean {
  try {
    assertInside(DATA_ROOT, candidate);
    return true;
  } catch {
    return false;
  }
}

export function describePath(p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(join(process.cwd(), p));
}
