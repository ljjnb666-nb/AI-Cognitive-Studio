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


## Private real-book fixture intake (REAL-BOOK-BENCHMARK-01A)

Synthetic F1–F12 fixtures remain the deterministic ground-truth suite. Real
user-provided PDFs are **private, additional inputs**, not public fixtures.
The private selection JSON belongs to the user's separate evidence package
(schema `acs-real-book-fixtures-v1`); **never commit it, the ZIP, actual books,
OCR text, rendered pages, or any private benchmark artifacts to Git**.

1. Generate the synthetic fixtures and their manifest with `npm run fixtures`
   in this isolated benchmark tool. Confirm the manifest exists in
   `D:\ai-cognitive-pdf-benchmark-data\fixtures\fixtures.manifest.json`.
2. Put the user's original ebook ZIP and selection JSON somewhere **outside
   the repository**. Do not move source books into this worktree.
3. From `tools/pdf-parser-benchmark` run (PowerShell):

   ```powershell
   python scripts/import_private_real_books.py --zip "D:\private\电子书.zip" --selection "D:\private\real_book_selection.json" --dry-run
   python scripts/import_private_real_books.py --zip "D:\private\电子书.zip" --selection "D:\private\real_book_selection.json" --priority P0
   python -m unittest discover -s scripts -p "test_import_private_real_books.py" -v
   ```

The importer rejects out-of-allowlist fixture IDs, manifest collisions, unsafe
ZIP members, wrong byte counts and SHA-256, stale partial files, symlinks and
concurrent import locks. Dry-run hashes **all selected source bytes**, and
actual import stages each PDF to the private root with no-clobber installation.
A private manifest row includes `declaredBytes`, `expectedSha256`, and
`groundTruth: null`. `loadFixture()` validates both before launching any
parser; no missing ground truth is turned into a fabricated quality score.

After host preflight passes, start with one native-text PDF and only a bounded
OCR sample. Never interpret `--page-cap` as a limit on the production-equivalent
`pdfjs` adapter: it reads the entire document under production parser limits.
For Docling and MinerU, the default page cap is 50; full-book run comparisons
are not comparable with partial-page runs unless documented separately.

```powershell
npx tsx src/cli.ts preflight
npx tsx src/cli.ts run --parser pdfjs --fixture RB-PDF-01 --cold-only
npx tsx src/cli.ts run --parser docling --mode ocr --fixture RB-PDF-02 --cold-only
```

The heavy model commands above are **instructions, not CI test evidence**.
If the C: disk pressure, D: disk space, RAM or model readiness gates fail,
record the blocked state rather than bypassing preflight. Do not start
all modes or download models implicitly. Keep parser run outputs private.
Compare quality only after independent human page-level ground truth exists;
prior native-text checks or isolated Tesseract probes cannot prove a Docling/
MinerU winner. A successful import proves **sample identity**, not extraction
accuracy or whole-pipeline reliability.
