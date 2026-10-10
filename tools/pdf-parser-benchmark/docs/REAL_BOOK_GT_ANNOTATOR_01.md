# REAL-BOOK-GT-ANNOTATOR-01 — offline human annotation workbench

**Delivery scope:** a manual, Chinese-language, local-only page/block editor.
This does **not** attest that any real book has been annotated, inspected,
reviewed, OCR'd, parsed, evaluated or published. Quality remains **NOT_MEASURED**
until actual independent human ground truth exists and the separate
REAL-BOOK-QUALITY-01 gate is authorized and passed.

## Privacy and isolation

- This tool is a **code-only addition** to isolated
  `tools/pdf-parser-benchmark/annotation/`. No database, worker, Redis,
  PostgreSQL, network APIs, model calls, parser jobs or PDF reading.
- The Node 24 built-in HTTP server binds **127.0.0.1 only**, uses an ephemeral
  local port and requires a matching Host header. It accepts only GET requests
  for four allowlisted UI files (HTML/CSS/two JS modules). Other routes,
  POST/API/uploads and access to private files fail closed.
- Browser response uses a strict CSP: no connect, images, frames or external
  scripts. The UI has no analytics, service worker or browser local storage.
  Draft text exists only in that browser tab until the user manually saves it.
- Every draft and GT candidate is downloaded or written only when a **human
  clicks a save button**. Edge/Chrome may offer a Save File dialog; choose
  `D:\ai-cognitive-pdf-benchmark-data\fixtures`. In browsers without that
  API, a normal browser download occurs, which may be **on C:**: manually move
  the file to the private D: directory. The tool does not claim to know the
  chosen destination. **Never commit, upload or paste those JSON files.**
- The app does not read or display source book PDFs; view original books using
  your separate trusted local reader and transcribe them manually.
- Installing/starting this application on the actual D: host, opening private
  books, annotating them or executing a quality regrade requires separate
  authorization. GitHub cloud CI operates **only on synthetic test data**.

## Workflow — after explicit authorization and reviewed release

1. Open the isolated benchmark worktree, first verify its exact reviewed SHA,
   its trusted origin, and that existing private evidence remains untouched.
2. In the `tools/pdf-parser-benchmark` directory, using preinstalled Node 24,
   run `node scripts/serve_gt_annotation.mjs`. This does **not** start any
   parser or auto-open private files.
3. In the same computer's Edge/Chrome, open the printed
   `http://127.0.0.1:<ephemeral-port>/`. Use the fixed sample selector:
   - `RB-PDF-11` -> original `RB-PDF-01` pages **22, 107, 192**
   - `RB-PDF-12` -> original `RB-PDF-02` pages **73, 145, 261**
   - `RB-PDF-13` -> original `RB-PDF-03` pages **51, 127, 379**
4. Work through each of the three pages of a single subset. Use the original
   PDF's **physical page numbers** for human comparison, while the tool maps
   annotations to subset-local page indices `0,1,2`. Never substitute a
   printed page label for a physical source-page index.
5. Enter the **actual PDF page size in points** (this v1 shares one pageSize
   across all three subset pages). If physical dimensions differ, stop and
   expand the GT contract rather than fabricate a single dimension.
6. Add blocks **in reading order**: headings, paragraphs, lists, tables,
   figures, captions, footnotes, formulas, page header/footer/number noise.
   Reorder blocks with the ↑ and ↓ buttons. Set columns where relevant.
   A table's `tableTsv` uses real TABs between cells and newlines between
   rows, with equal columns per row. Formula blocks need canonical textual
   transcriptions. Figure-only pages may include an image block with no prose;
   **do not invent OCR text**. Include manually transcribed markers and OCR
   phrases only if they exist in the original.
7. Save `<fixture>.ground-truth.draft.json` frequently. This is a *draft
   editor state*, not a GT sidecar; use **Import existing draft** to resume.
   Because there is no autosave/localStorage, closing before saving loses edits.
8. After entering all three pages, click **Check all 3 pages**; it verifies
   page coverage, marker presence, OCR phrase consistency, structural shape,
   table rectangularity, and fixed lineage. Then export
   `<fixture>.ground-truth.json`, with the existing GroundTruth schema and
   deterministic page/reading-order IDs. The exported file is still a
   **candidate that has not been independently reviewed**.
9. Repeat for all three fixtures (total nine human-reviewed source pages).

## What this helper does NOT verify

- It cannot establish that a person used the original book rather than a
  parser transcript, that every glyph/figure/cell is correct, or that the
  source PDF and subset hashes match the separately held private manifest.
- It **does not create** `<fixture>.ground-truth.review.json`, does not mark
  review checkboxes as complete, and does not fabricate reviewer IDs or
  timestamps. To unlock the separate v2 quality regrade, **two different
  actual reviewers** must independently check every source physical page,
  fill the reviewed sidecar per
  `docs/REAL_BOOK_QUALITY_01.md`, and bind its exact candidate-byte
  SHA-256 and source/subset fixture SHA-256 to the private manifest.
- It does not evaluate PDF.js, LiteParse, OCR, page fidelity or quality. In
  particular, **EXECUTION_OK is not extraction quality**, and the two scanned
  PDF.js negative controls must remain ungraded.
- It does not validate a complete figure/table *semantic equivalence*; final
  editorial quality thresholds and product shipping decision are separate.

## Synthetic tests and verification (no private data)

```powershell
# In tools/pdf-parser-benchmark after a reviewed checkout:
node --check annotation/workspace.mjs
node --check annotation/app.mjs
node --check annotation/server.mjs
node --check scripts/serve_gt_annotation.mjs
npx --no-install vitest run tests/gt-annotation.test.mjs
```

The test includes an independently constructed synthetic three-page draft,
requires the existing Zod `parseGroundTruth` contract, checks reading order,
tables/lists/formulas/noise/OCR pages, and exercises negative lineage/missing
content/unsafe import cases. It starts a **synthetic-only** ephemeral loopback
server to check GET allowlist, Host denial, blocked POST and CSP.
The cloud CI gate uses `npm ci --ignore-scripts`; it never accesses a
self-hosted runner or D: book files.
