# PDF Parser Benchmark (isolated)

Smoke + quality benchmark harness for PDF parsers, built on the dedicated git
worktree (`D:\所有项目\90_Worktrees\AI-Cognitive-Studio-pdf-parser-benchmark`,
branch `codex/pdf-parser-benchmark`). It is **not** part of the pnpm
workspace (`pnpm-workspace.yaml` only covers `apps/*` and `packages/*`) and
production code must never import it.

## Isolation guarantees

- No production imports: the harness never imports `@ai-cognitive/*` and never
  touches PostgreSQL, Redis, MinIO, Prisma, or any production queue.
- The only production code executed is the real PDF parser entry point
  (`packages/ingestion/src/document-parsers.ts` → `pdfjs-isolated`), driven
  unchanged — same limits, same child process, same canonicalization (#14).
- All heavy artifacts (models, caches, temp, outputs, reports, fixtures) live
  under `D:\ai-cognitive-pdf-benchmark-data` (per-parser subdirectories), so
  the C: drive is never written by parser runs (TEMP/TMP and HF_HOME/MINERU_HOME
  are redirected explicitly).
- Parser output is treated as untrusted: schema validation, semantic checks
  and path containment run before anything is recorded (#29/#30).

## Run evidence (immutable run directories)

Every parser execution persists as an immutable, self-contained run directory —
one `runId` maps to exactly one directory, cold and warm runs never share one,
and later runs (success or failure) never overwrite earlier evidence:

```
outputs/<fixtureId>/<parserKey>/runs/<runId>/
  result.json        # completion marker, written LAST via temp-file rename
  normalized.json
  metrics.json
  quality.json       # Phase 2B deterministic quality sidecar (additive)
  stdout.log
  stderr.log
  raw/               # raw parser artifacts for THIS run only
```

- `<parserKey>` is per mode (`pdfjs`, `liteparse`, `liteparse-ocr`, `docling`,
  `docling-ocr`, `mineru-flash`, `mineru-basic`, …), so parser modes — including
  native-text vs OCR-enabled modes — never share result directories.
- A run directory without a parsable `result.json` is an incomplete run; the
  aggregate report lists it under "Skipped / invalid artifacts" and never
  counts it as a successful benchmark result.
- `quality.json` failure semantics: a missing ground truth records
  `SKIPPED_GROUND_TRUTH_MISSING`, an invalid sidecar
  `SKIPPED_GROUND_TRUTH_INVALID`, an evaluator crash
  `QUALITY_EVALUATION_FAILED` — none of them ever mutate the parser evidence.
- The aggregate report reads ALL persisted runs — cold and warm stay separate
  rows; nothing is merged or averaged, and no winner is computed.

## Ground truth (Phase 2B)

Every synthetic fixture is generated together with a `ground-truth.json`
sidecar from the SAME constants (never derived from parser output). Ground
truth covers expected text, per-block reading order (B1..Bn, page + column
ownership), headings, lists, table cell grids, formulas, OCR-required pages
and repeated header/footer noise. Evaluation is deterministic (no LLM
scoring) with a fixed normalization policy: NFKC, then remove all Unicode
whitespace — hanzi, digits and punctuation are never removed.

Fixture matrix: `F1` native Chinese prose, `F2` two-column English,
`F3` image-only scanned Chinese (OCR required), `F4` textbook composite
(headings/table/figure/footnotes), `F5` 520-page long book, `F6` native
English prose, `F7` two-column Chinese with per-block order, `F8` ruled table
(CN/numeric/empty cells), `F9` inline + display formulas, `F10` ordered /
nested / unordered lists, `F11` repeated header/footer noise, `F12` mixed
(native + scanned + table pages), plus `warmup` and `not-a-pdf` (malformed
input).

Quality metrics per run: text fidelity (char recall/precision via multiset
overlap, bounded edit distance, trigram recall, duplicate ratio, unexpected
ratio, missing key markers), reading order (ordered-pair accuracy over
matched blocks, two-column interleaving detection), structure (heading /
paragraph / list / figure detection with unsupported-vs-missed states), page
fidelity (block→page accuracy, bbox sanity incl. wildly-invalid detection),
tables (structural vs `TABLE_FLATTENED_TO_TEXT`, cell recovery, row order),
formulas (structural / text / dropped / corrupted), OCR (char recall, key
phrase recovery, page coverage, truthful OCR metadata — unknown upstream
fields stay null) and header/footer contamination.

## Parsers under test

| id | parser | binding |
| --- | --- | --- |
| `pdfjs` | pdfjs-isolated (production baseline) | packages/ingestion @ pdfjs-dist 6.2.108 — OCR: `OCR_UNSUPPORTED` (baseline performs no OCR; never wrapped externally) |
| `liteparse` / `liteparse-ocr` | LiteParse 2.14.6 | `@llamaindex/liteparse` Node native binding, `ocrEnabled` flag |
| `docling` / `docling-ocr` | Docling 2.129.0 | isolated Python 3.12 venv (D:), explicit `do_ocr` policy |
| `mineru` (flash/basic) | MinerU 4.0.3 | isolated Python 3.12 venv (D:), local tiers via its `server`; pipeline OCRs image-only pages by design, engine fields not exposed upstream → null |

OCR provenance is recorded per run (`ocrModeRequested` = benchmark intent,
`ocrEnabled`/engine/model/language = upstream-reported facts or null).

## Layout

```
src/        harness, runner, schema, filesystem guard, resource monitor, report,
            ground truth loader, deterministic quality evaluator (src/quality/),
            decision evidence pack (src/evidence.ts)
adapters/   per-parser adapters (+ child entry scripts)
python/     docling runner script (mineru uses its upstream CLI)
scripts/    setup.mjs (pdfjs child module junction), make-fixtures.mjs (PDF + ground truth)
fixtures/   committed manifest only — PDFs and ground truth live on D:, never in git
tests/      harness safety + deterministic quality tests
```

## Usage

```bash
npm install
npm run setup          # create root node_modules junction for the pdfjs child
npm run fixtures       # generate synthetic fixtures + ground truth into D:\...\fixtures
npx tsx src/cli.ts preflight
npx tsx src/cli.ts setup-models        # untimed model preload for docling/mineru (+ docling OCR)
npx tsx src/cli.ts run --parser pdfjs --fixture F1-native-cn
npx tsx src/cli.ts run --parser docling --mode ocr --fixture F3-scanned-cn
npx tsx src/cli.ts run-all             # full smoke matrix + report
npx tsx src/cli.ts evidence-pack       # reports/<ts>/: summary, quality, capability, env, versions, decision evidence
npm test
```

## Safety

- Every run: isolated temp dir (cleaned in success/failure/timeout paths),
  wall-clock timeout, process-tree kill (`taskkill /T`), stdout/stderr caps,
  output-dir size cap, per-run working directory.
- Disk guard: any step stops when C: free < 15 GB (STOP_REASON =
  C_DRIVE_PRESSURE) or D: free < 30 GB. `skipPreflight` exists ONLY for unit
  tests — real benchmark evidence always runs the real preflight.
- RAM preflight per parser before each run; insufficient RAM records
  `SKIPPED_RESOURCE_CONSTRAINT` instead of forcing a run.
- Facts only: no overall score, no winner is computed (#40).
