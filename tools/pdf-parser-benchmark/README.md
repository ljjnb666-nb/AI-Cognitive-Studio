# PDF Parser Benchmark (isolated)

Smoke-benchmark harness for PDF parsers, built on a dedicated git worktree
(`D:\AI-Cognitive-Studio-PDF-Benchmark`, branch
`codex/pdf-parser-benchmark-phase-1`). It is **not** part of the pnpm
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
  the nearly-full C: drive is never written by parser runs (TEMP/TMP and
  HF_HOME/MINERU_HOME are redirected explicitly).
- Parser output is treated as untrusted: schema validation, semantic checks
  and path containment run before anything is recorded (#29/#30).

## Parsers under test (Phase 1)

| id | parser | binding |
| --- | --- | --- |
| `pdfjs` | pdfjs-isolated (production baseline) | packages/ingestion @ pdfjs-dist 6.2.108 |
| `liteparse` | LiteParse 2.14.6 | `@llamaindex/liteparse` Node native binding |
| `docling` | Docling 2.129.0 | isolated Python 3.12 venv (D:) |
| `mineru` | MinerU 4.0.3 | isolated Python 3.12 venv (D:), local tiers via its `server` |

OCR is not enabled anywhere in Phase 1 (`OCR_NOT_TESTED`).

## Layout

```
src/        harness, runner, schema, filesystem guard, resource monitor, report
adapters/   per-parser adapters (+ child entry scripts)
python/     docling runner script (mineru uses its upstream CLI)
scripts/    setup.mjs (pdfjs child module junction), make-fixtures.mjs
fixtures/   committed manifest only — PDFs live on D:, never in git
tests/      harness safety tests (schema, guard, timeout/kill, isolation)
```

## Usage

```bash
npm install
npm run setup          # create root node_modules junction for the pdfjs child
npm run fixtures       # generate synthetic fixtures into D:\...\fixtures
npx tsx src/cli.ts preflight
npx tsx src/cli.ts setup-models        # untimed model preload for docling/mineru
npx tsx src/cli.ts run --parser pdfjs --fixture F1-native-cn
npx tsx src/cli.ts run-all             # full smoke matrix + report
npm test
```

## Safety

- Every run: isolated temp dir (cleaned in success/failure/timeout paths),
  wall-clock timeout, process-tree kill (`taskkill /T`), stdout/stderr caps,
  output-dir size cap, per-run working directory.
- Disk guard: any step stops when C: free < 15 GB (STOP_REASON =
  C_DRIVE_PRESSURE) or D: free < 30 GB.
- RAM preflight per parser before each run; insufficient RAM records
  `SKIPPED_RESOURCE_CONSTRAINT` instead of forcing a run.
- Facts only: no overall score, no winner is computed (#40).
