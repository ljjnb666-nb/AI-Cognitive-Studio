import { createHash, randomUUID } from "node:crypto";
import { readFile, lstat, readdir, open, rename, rm } from "node:fs/promises";
import { join, resolve, sep, relative } from "node:path";
import { z } from "zod";
import { DATA_ROOT, FIXTURES_ROOT, OUTPUTS_ROOT, REPORTS_ROOT } from "./filesystem-guard.js";
import { parseGroundTruth, type GroundTruth } from "./ground-truth.js";
import { evaluateQuality } from "./quality/evaluate.js";
import { parseQualityReport } from "./quality/schema.js";
import { parseBenchmarkResult, parseNormalizedOutput } from "./schema.js";

/** REAL-BOOK-QUALITY-01: offline regrading of immutable native evidence.
 * No parser process, no source PDF, no file writes to a run directory.
 * ALL annotated text and detailed metrics remain private on D:.
 */
export const BENCHMARK_HEAD = "56c0100043345085a4df35e995d40f4f50a7f9d2";
export const SOURCE_RUN_ID = 38026320680;
/** Metadata-only report digest attested by independent Actions #38029075853. */
export const SOURCE_REPORT_SHA256 = "e4f4a7b04adfaa484e3538921647127225057b9fdcf0015234fcd8f454b08f76";
export const SOURCE_START_NS = BigInt(Date.parse("2026-10-10T05:05:29Z")) * 1_000_000n;
export const SOURCE_END_NS = BigInt(Date.parse("2026-10-10T05:05:59Z")) * 1_000_000n;
export const PAGES: Record<string, { source: string; pages: number[] }> = {
  "RB-PDF-11": { source: "RB-PDF-01", pages: [22, 107, 192] },
  "RB-PDF-12": { source: "RB-PDF-02", pages: [73, 145, 261] },
  "RB-PDF-13": { source: "RB-PDF-03", pages: [51, 127, 379] },
};

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const shaSchema = z.string().regex(/^[0-9a-f]{64}$/);
const PageAudit = z.object({
  subsetPageIndex: z.number().int().min(0).max(2),
  originalPhysicalPage1Based: z.number().int().positive(),
  textCheckedAgainstOriginal: z.literal(true),
  figuresChecked: z.literal(true),
  tablesChecked: z.literal(true),
  formulasChecked: z.literal(true),
  citationLocatorChecked: z.literal(true),
}).strict();
const Reviewer = z.object({
  reviewerId: z.string().regex(/^[a-zA-Z0-9_-]{3,48}$/),
  confirmedAgainstOriginal: z.literal(true),
  independentReview: z.literal(true),
  reviewedAt: z.string().datetime(),
}).strict();
const Review = z.object({
  schema: z.literal("acs-real-book-human-ground-truth-review-v1"),
  fixtureId: z.enum(["RB-PDF-11", "RB-PDF-12", "RB-PDF-13"]),
  sourceFixtureId: z.enum(["RB-PDF-01", "RB-PDF-02", "RB-PDF-03"]),
  sourceFixtureSha256: shaSchema,
  subsetFixtureSha256: shaSchema,
  groundTruthSha256: shaSchema,
  sourcePages1Based: z.tuple([z.number().int().positive(), z.number().int().positive(), z.number().int().positive()]),
  pageAudits: z.array(PageAudit).length(3),
  reviewers: z.array(Reviewer).min(2).max(4),
}).strict();

export class PrivateQualityGateError extends Error {
  constructor(public readonly code: string) { super(code); }
}
function refuse(code: string): never { throw new PrivateQualityGateError(code); }
function identityRows(manifest: unknown): Map<string, { expectedSha256: string }> {
  if (!manifest || typeof manifest !== "object" || !("fixtures" in manifest)) refuse("MANIFEST_INVALID");
  const rows = (manifest as { fixtures: unknown }).fixtures;
  if (!Array.isArray(rows) || rows.length > 10000) refuse("MANIFEST_INVALID");
  const map = new Map<string, { expectedSha256: string }>();
  for (const id of Object.keys(PAGES).concat(Object.values(PAGES).map(v => v.source))) {
    const found = rows.filter((x: unknown) => x && typeof x === "object" && (x as { id?: unknown }).id === id);
    if (found.length !== 1) refuse("MANIFEST_IDENTITY_MISSING");
    const record = found[0] as Record<string, unknown>;
    if (!shaSchema.safeParse(record.expectedSha256).success) refuse("MANIFEST_SHA_INVALID");
    map.set(id, { expectedSha256: record.expectedSha256 as string });
    if (id in PAGES) {
      const lineage = PAGES[id]!;
      if (record.sourceFixtureId !== lineage.source || JSON.stringify(record.sourcePages1Based) !== JSON.stringify(lineage.pages) ||
          record.sourceSha256 !== rows.find((x: unknown) => x && typeof x === "object" && (x as { id?: unknown }).id === lineage.source)?.expectedSha256) {
        refuse("MANIFEST_LINEAGE_INVALID");
      }
    }
  }
  return map;
}

/** Structural checks cannot independently attest a human reviewed the book;
 * two declared independent reviews + every physical page are required.
 */
export function validateHumanReview(raw: unknown, fixture: string, gtBytes: Buffer, gt: GroundTruth, identities: Map<string, { expectedSha256: string }>): void {
  const parsed = Review.safeParse(raw);
  if (!parsed.success) refuse("HUMAN_REVIEW_INVALID");
  const review = parsed.data;
  const identity = PAGES[fixture];
  if (!identity || review.fixtureId !== fixture || review.sourceFixtureId !== identity.source ||
      review.sourceFixtureSha256 !== identities.get(identity.source)?.expectedSha256 ||
      review.subsetFixtureSha256 !== identities.get(fixture)?.expectedSha256 ||
      review.groundTruthSha256 !== sha(gtBytes) ||
      JSON.stringify(review.sourcePages1Based) !== JSON.stringify(identity.pages)) refuse("HUMAN_REVIEW_IDENTITY_MISMATCH");
  if (new Set(review.reviewers.map(r => r.reviewerId)).size !== review.reviewers.length) refuse("HUMAN_REVIEW_DUPLICATE_REVIEWER");
  if (new Set(review.pageAudits.map(a => a.subsetPageIndex)).size !== 3) refuse("HUMAN_REVIEW_PAGE_COVERAGE");
  for (const a of review.pageAudits) if (a.originalPhysicalPage1Based !== identity.pages[a.subsetPageIndex]) refuse("HUMAN_REVIEW_PAGE_MAP");
  if (gt.fixtureId !== fixture || gt.pages !== 3 || !/human/i.test(gt.generator) ||
      gt.normalizationPolicy !== "NFKC + remove whitespace" ||
      gt.blocks.length === 0 || gt.keyMarkers.length === 0 ||
      gt.text.trim().length === 0) refuse("GROUND_TRUTH_NOT_COMPLETE");
  for (const b of gt.blocks) if (b.page > 2) refuse("GROUND_TRUTH_PAGE_OUT_OF_RANGE");
  for (const p of gt.ocrRequiredPages) if (p > 2) refuse("GROUND_TRUTH_PAGE_OUT_OF_RANGE");
  if (new Set(gt.blocks.map(b => b.id)).size !== gt.blocks.length) refuse("GROUND_TRUTH_BLOCK_IDS_DUPLICATE");
}

async function boundedFile(file: string, root: string, maximum: number): Promise<Buffer> {
  const base = resolve(root), actual = resolve(file);
  if (!actual.startsWith(base + sep)) refuse("PATH_OUTSIDE_PRIVATE_ROOT");
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) refuse("PRIVATE_ROOT_NOT_REGULAR");
  // Reject junctions/symlinks at EVERY intermediate component, not only
  // at the final file; a trusted-looking path must not escape D: by link.
  let parent = base;
  for (const component of relative(base, actual).split(sep).slice(0, -1)) {
    parent = join(parent, component);
    const segment = await lstat(parent);
    if (!segment.isDirectory() || segment.isSymbolicLink()) refuse("PRIVATE_PATH_LINK_BLOCKED");
  }
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) refuse("PRIVATE_FILE_INVALID");
  return readFile(file);
}
function parsePrivateJson(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { return refuse("PRIVATE_JSON_INVALID"); }
}
function isSafeId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(id);
}
export type PrivateQualitySummary = {
  sourceGithubRun: number;
  qualityStatus: "MEASURED_PENDING_PRODUCT_ACCEPTANCE";
  groundTruthStatus: "HUMAN_REVIEW_ATTESTED";
  evaluatorVersion: "pdf-quality-eval-v2";
  planned: 6; evaluated: 4; expectedCapabilityRejections: 2;
  qualityMeasured: true;
  rankedParsers: false;
  results: Array<{ fixtureId: string; parser: string; status: "EVALUATED" | "EXPECTED_CAPABILITY_REJECTION"; originalPages: number[]; quality: unknown | null }>;
};
/** Evaluate four accepted native runs, leave two capability refusals ungraded. */
export async function regradePrivateNativeEvidence(root = DATA_ROOT): Promise<PrivateQualitySummary> {
  if (resolve(root) !== resolve(DATA_ROOT)) refuse("DATA_ROOT_MISMATCH");
  const reportDir = resolve(REPORTS_ROOT);
  const manifests = resolve(FIXTURES_ROOT);
  const outputs = resolve(OUTPUTS_ROOT);
  for (const dir of [root, reportDir, manifests, outputs]) {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("PRIVATE_DIRECTORY_INVALID");
  }
  const entries = await readdir(reportDir);
  const matching = entries.filter(name => {
    const match = /^real-book-matrix-native-(\d{19})\.json$/.exec(name);
    return match && BigInt(match[1]!) >= SOURCE_START_NS && BigInt(match[1]!) <= SOURCE_END_NS;
  });
  if (matching.length !== 1) refuse("SOURCE_REPORT_NOT_UNIQUE");
  const sourceFile = join(reportDir, matching[0]!);
  const sourceStat = await lstat(sourceFile);
  if (sourceStat.mtimeMs < Number(SOURCE_START_NS / 1_000_000n) - 10000 ||
      sourceStat.mtimeMs > Number(SOURCE_END_NS / 1_000_000n) + 10000) refuse("SOURCE_REPORT_MTIME_INVALID");
  const originalBytes = await boundedFile(sourceFile, reportDir, 131072);
  if (sha(originalBytes) !== SOURCE_REPORT_SHA256) refuse("PINNED_REPORT_SHA_MISMATCH");
  const original = parsePrivateJson(originalBytes) as Record<string, unknown>;
  const manifest = parsePrivateJson(await boundedFile(join(manifests, "fixtures.manifest.json"), manifests, 1048576));
  const identities = identityRows(manifest);
  if (!original || original.schema !== "acs-real-book-model-comparison-v1" || original.status !== "BASELINE_COMPLETE_WITH_EXPECTED_REJECTIONS" ||
      original.selectedSuite !== "native" || original.qualityGroundTruth !== "NOT_MEASURED" ||
      original.planned !== 6 || original.completed !== 6 || original.executionPasses !== 4 ||
      original.expectedRejections !== 2 || original.unexpectedFailures !== 0 ||
      original.serverShutdownOk !== true || !Array.isArray(original.results) || original.results.length !== 6) refuse("SOURCE_REPORT_CONTRACT_INVALID");

  const truths = new Map<string, GroundTruth>();
  for (const fixture of Object.keys(PAGES)) {
    const gtBytes = await boundedFile(join(manifests, fixture + ".ground-truth.json"), manifests, 4 * 1024 * 1024);
    const gt = parseGroundTruth(parsePrivateJson(gtBytes));
    const reviewBytes = await boundedFile(join(manifests, fixture + ".ground-truth.review.json"), manifests, 65536);
    validateHumanReview(parsePrivateJson(reviewBytes), fixture, gtBytes, gt, identities);
    truths.set(fixture, gt);
  }

  const expected = new Set(Object.keys(PAGES).flatMap(fixture => ["pdfjs", "liteparse"].map(parser => fixture + "/" + parser)));
  const seen = new Set<string>();
  const results: PrivateQualitySummary["results"] = [];
  for (const row of original.results as Array<Record<string, unknown>>) {
    const fixture = row.fixtureId, parser = row.parser;
    const key = fixture + "/" + parser;
    if (typeof fixture !== "string" || typeof parser !== "string" || !expected.has(key) || seen.has(key) || row.mode !== "default") refuse("SOURCE_MATRIX_INVALID");
    seen.add(key);
    const source = PAGES[fixture]!;
    if (row.subsetSha256 !== identities.get(fixture)?.expectedSha256 ||
        row.parentSha256 !== identities.get(source.source)?.expectedSha256 ||
        JSON.stringify(row.sourcePages1Based) !== JSON.stringify(source.pages) ||
        row.tempClean !== true) refuse("SOURCE_LINEAGE_INVALID");
    if (row.status === "EXPECTED_CAPABILITY_REJECTION") {
      if (parser !== "pdfjs" || !["RB-PDF-12", "RB-PDF-13"].includes(fixture) ||
          row.failureKind !== "EXPECTED_CAPABILITY_REJECTION" || row.reasonCode !== "SOURCE_OCR_REQUIRED" ||
          row.childExitCode !== 3 || row.cliExitCode === 0) refuse("UNEXPECTED_REJECTION");
      results.push({ fixtureId: fixture, parser, status: "EXPECTED_CAPABILITY_REJECTION", originalPages: source.pages, quality: null });
      continue;
    }
    if (row.status !== "EXECUTION_OK" || row.reasonCode !== "NONE" || row.childExitCode !== 0 || row.cliExitCode !== 0 ||
        !isSafeId(row.runId)) refuse("SOURCE_ACCEPTED_RUN_INVALID");
    const runDir = join(outputs, fixture, parser, "runs", row.runId);
    const runDirStat = await lstat(runDir);
    if (!runDirStat.isDirectory() || runDirStat.isSymbolicLink()) refuse("RUN_DIRECTORY_INVALID");
    const result = parseBenchmarkResult(parsePrivateJson(await boundedFile(join(runDir, "result.json"), outputs, 1048576)));
    const normalized = parseNormalizedOutput(parsePrivateJson(await boundedFile(join(runDir, "normalized.json"), outputs, 32 * 1024 * 1024)));
    if (result.run.id !== row.runId || result.run.coldStart !== true || result.document.fixtureId !== fixture ||
        result.document.inputSha256 !== identities.get(fixture)?.expectedSha256 ||
        result.reliability.exitCode !== 0 || result.reliability.failureKind !== null ||
        normalized.fixtureId !== fixture || normalized.pages.length !== 3) refuse("IMMUTABLE_RUN_IDENTITY_INVALID");
    const quality = parseQualityReport(evaluateQuality({
      runId: row.runId, fixtureId: fixture, parserKey: parser, parserMode: "default",
      groundTruth: truths.get(fixture)!, normalized, ocrMetadata: normalized.ocr ?? null,
    }));
    if (quality.status !== "EVALUATED" || quality.evaluatorVersion !== "pdf-quality-eval-v2") refuse("V2_QUALITY_EVALUATION_FAILED");
    results.push({ fixtureId: fixture, parser, status: "EVALUATED", originalPages: source.pages, quality });
  }
  if (seen.size !== 6 || results.filter(r => r.status === "EVALUATED").length !== 4 ||
      results.filter(r => r.status === "EXPECTED_CAPABILITY_REJECTION").length !== 2) refuse("FINAL_MATRIX_INVALID");
  return {
    sourceGithubRun: SOURCE_RUN_ID, qualityStatus: "MEASURED_PENDING_PRODUCT_ACCEPTANCE",
    groundTruthStatus: "HUMAN_REVIEW_ATTESTED", evaluatorVersion: "pdf-quality-eval-v2",
    planned: 6, evaluated: 4, expectedCapabilityRejections: 2,
    qualityMeasured: true, rankedParsers: false, results,
  };
}

/** Atomic private output only. Never echo contents to stdout. */
export async function writePrivateQualityReport(report: PrivateQualitySummary): Promise<void> {
  const stat = await lstat(REPORTS_ROOT);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("REPORT_ROOT_INVALID");
  const id = Date.now() + "-" + process.pid + "-" + randomUUID();
  const output = join(REPORTS_ROOT, "real-book-quality-" + id + ".json");
  const staging = join(REPORTS_ROOT, ".real-book-quality-" + id + ".json.part");
  const fh = await open(staging, "wx", 0o600);
  try {
    await fh.writeFile(JSON.stringify(report, null, 2) + "\n", "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(staging, output);
  } catch {
    await rm(staging, { force: true }).catch(() => undefined);
    refuse("PRIVATE_QUALITY_PERSIST_FAILED");
  }
}
