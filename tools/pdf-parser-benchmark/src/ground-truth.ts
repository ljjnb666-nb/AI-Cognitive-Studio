import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { FIXTURES_ROOT, assertInside } from "./filesystem-guard.js";

/**
 * Deterministic ground-truth contract (Phase 2B spec #4).
 * Every synthetic fixture generator emits its PDF and this sidecar from the
 * SAME source constants — ground truth is never derived from parser output.
 * Unknown/absent aspects are null or empty, never fabricated.
 */

export const GtBlock = z.object({
  id: z.string().min(1), // B1, B2, ... canonical reading-order position
  page: z.number().int().nonnegative(),
  column: z.number().int().nonnegative().nullable(), // null = single-column document
  role: z.enum(["heading", "paragraph", "list_item", "table", "figure", "caption", "footnote", "formula", "header", "footer", "page_number"]),
  text: z.string(),
});

export const GtTable = z.object({
  page: z.number().int().nonnegative(),
  rows: z.number().int().nonnegative(),
  cols: z.number().int().nonnegative(),
  /** Full cell grid including the header row, row-major. Empty string = empty cell. */
  cells: z.array(z.array(z.string())),
});

export const GtFormula = z.object({
  page: z.number().int().nonnegative(),
  display: z.boolean(),
  /** Canonical text exactly as rendered into the PDF. */
  text: z.string(),
});

export const GtList = z.object({
  page: z.number().int().nonnegative(),
  ordered: z.boolean(),
  items: z.array(z.string().min(1)),
});

export const GroundTruth = z.object({
  fixtureId: z.string().min(1),
  generator: z.string().min(1),
  pages: z.number().int().nonnegative(),
  pageSize: z.object({ width: z.number().positive(), height: z.number().positive() }),
  ocrRequired: z.boolean(),
  /** Pages that are image-only and require OCR (subset knowledge for mixed fixtures). */
  ocrRequiredPages: z.array(z.number().int().nonnegative()),
  /**
   * Fixed normalization policy for evaluation (documented, never tuned per run):
   * NFKC, then remove all Unicode whitespace. Hanzi, digits and punctuation are
   * always kept.
   */
  normalizationPolicy: z.string().min(1),
  /** Canonical expected full text in reading order (noise excluded). */
  text: z.string(),
  /** Distinctive phrases that must survive extraction (headings + sentinels). */
  keyMarkers: z.array(z.string().min(1)),
  /** Phrases whose presence proves OCR page success, per scanned page. */
  ocrKeyPhrases: z.array(z.object({ page: z.number().int().nonnegative(), phrase: z.string().min(1) })),
  blocks: z.array(GtBlock),
  headings: z.array(z.object({ page: z.number().int().nonnegative(), text: z.string().min(1) })),
  lists: z.array(GtList),
  tables: z.array(GtTable),
  formulas: z.array(GtFormula),
  /** Repeated per-page noise (headers/footers/page numbers) that must NOT leak into body text. */
  noise: z.array(z.object({ kind: z.enum(["header", "footer", "page_number"]), text: z.string() })),
});
export type GroundTruth = z.infer<typeof GroundTruth>;
export type GtBlock = z.infer<typeof GtBlock>;

export class GroundTruthValidationError extends Error {
  constructor(public readonly issues: string) {
    super(`GROUND_TRUTH_INVALID: ${issues}`);
  }
}

export function parseGroundTruth(raw: unknown): GroundTruth {
  const parsed = GroundTruth.safeParse(raw);
  if (!parsed.success) throw new GroundTruthValidationError(JSON.stringify(parsed.error.issues));
  return parsed.data;
}

export function groundTruthPath(fixtureId: string): string {
  return assertInside(FIXTURES_ROOT, join(FIXTURES_ROOT, `${fixtureId}.ground-truth.json`), "ground-truth");
}

export type LoadedGroundTruth =
  | { status: "LOADED"; groundTruth: GroundTruth }
  | { status: "MISSING" }
  | { status: "INVALID"; error: string };

/** Loads the fixture's ground truth; a missing file is a normal "not measurable" state. */
export async function loadGroundTruth(fixtureId: string): Promise<LoadedGroundTruth> {
  let raw: string;
  try {
    raw = await readFile(groundTruthPath(fixtureId), "utf8");
  } catch {
    return { status: "MISSING" };
  }
  try {
    return { status: "LOADED", groundTruth: parseGroundTruth(JSON.parse(raw)) };
  } catch (error) {
    return { status: "INVALID", error: error instanceof Error ? error.message : String(error) };
  }
}
