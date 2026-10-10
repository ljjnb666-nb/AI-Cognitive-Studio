# REAL-BOOK-QUALITY-01 — independent human Ground Truth and offline v2 regrade

**Status at implementation:** NO REAL-BOOK GT HAS BEEN SUPPLIED OR VERIFIED.
This phase develops the tool; it is **NOT** a declaration that quality evaluation passed.

## Authority and scope

- Trusted benchmark branch: `codex/pdf-parser-benchmark`, initially pinned at
  `56c0100043345085a4df35e995d40f4f50a7f9d2`.
- Source Windows Actions run: `38026320680`, 2026-10-10T05:05:29Z through
  2026-10-10T05:05:59Z. Six original native runs: four accepted executions,
  two expected PDF.js `SOURCE_OCR_REQUIRED` negative controls.
- Read-only source artifacts:
  `D:\ai-cognitive-pdf-benchmark-data\reports\real-book-matrix-native-<timestamp>.json`
  and, for the four accepted runs only, immutable
  `outputs\<fixture>\<parser>\runs\<runId>\result.json` and
  `normalized.json`. The Python source matrix CLI is **not rerun**.
- The built-in `pdf-quality-eval-v2` evaluates existing normalized results
  with independently annotated, private GT. Do not fork its metric formulas,
  recalculate from summary counts or judge char count as quality.
- It intentionally does **not** execute parsers, OCR, model setup, PDF reading,
  Tesseract, internet requests, git changes or dependency installation.
- Results and raw metrics are private in `D:\ai-cognitive-pdf-benchmark-data\reports`
  only. The CLI emits safe fixed status/counts and **no raw content or scores**.

## Required human-created inputs, all private

For each `RB-PDF-11`, `RB-PDF-12` and `RB-PDF-13` create:

1. `fixtures/<ID>.ground-truth.json` using the existing
   `src/ground-truth.ts` Zod contract (not a parser output conversion).
   Set `fixtureId`, `generator: "human-curated-from-original"`, `pages: 3`,
   accurate pageSize and `normalizationPolicy: "NFKC + remove whitespace"`.
   Include independently transcribed canonical text, page-local ordered blocks
   (`page` is **0, 1, 2**, not original physical page), keyMarkers, actual
   heading/list/table/formula/figure data, OCR-required pages, and noise.
   Unsupported or not-present evidence must not be invented. Never construct
   GT by copying PDF.js/LiteParse output, nor use an LLM to guess GT.
2. `fixtures/<ID>.ground-truth.review.json` with schema
   `acs-real-book-human-ground-truth-review-v1`.
   Use the same SHA-256 as the exact GT bytes; source/subset hashes must match
   the private manifest, with all three original physical page numbers pinned.
   The review attestations must be based on the **source PDF pages**, not a
   parser transcript. Independent reviewers must not merely agree on an output.

Review file *shape* (example values are **placeholders**, not valid evidence):

```json
{
  "schema": "acs-real-book-human-ground-truth-review-v1",
  "fixtureId": "RB-PDF-11",
  "sourceFixtureId": "RB-PDF-01",
  "sourceFixtureSha256": "<actual 64-character SHA256 from private manifest>",
  "subsetFixtureSha256": "<actual 64-character SHA256 from private manifest>",
  "groundTruthSha256": "<SHA256 over EXACT GT JSON bytes>",
  "sourcePages1Based": [22, 107, 192],
  "pageAudits": [
    {"subsetPageIndex": 0, "originalPhysicalPage1Based": 22, "textCheckedAgainstOriginal": true, "figuresChecked": true, "tablesChecked": true, "formulasChecked": true, "citationLocatorChecked": true},
    {"subsetPageIndex": 1, "originalPhysicalPage1Based": 107, "textCheckedAgainstOriginal": true, "figuresChecked": true, "tablesChecked": true, "formulasChecked": true, "citationLocatorChecked": true},
    {"subsetPageIndex": 2, "originalPhysicalPage1Based": 192, "textCheckedAgainstOriginal": true, "figuresChecked": true, "tablesChecked": true, "formulasChecked": true, "citationLocatorChecked": true}
  ],
  "reviewers": [
    {"reviewerId": "reviewer-one", "confirmedAgainstOriginal": true, "independentReview": true, "reviewedAt": "2026-10-10T00:00:00.000Z"},
    {"reviewerId": "reviewer-two", "confirmedAgainstOriginal": true, "independentReview": true, "reviewedAt": "2026-10-10T00:00:00.000Z"}
  ]
}
```

Do NOT mark a check true until an actual independent review is complete.
The tool can validate structure and declared attestation, **not** prove honesty
or that the human transcribed each page correctly. Source-page visual review
and evaluator interpretation remain independent human obligations.

Page mapping:
- RB-PDF-11 <- RB-PDF-01: [22, 107, 192].
- RB-PDF-12 <- RB-PDF-02: [73, 145, 261].
- RB-PDF-13 <- RB-PDF-03: [51, 127, 379].

Beware: `normalized.pages[].pageIndex` and GT block `page` are
**subset-local 0-based**. Map to original physical page only with the private
manifest `sourcePages1Based[pageIndex]`. A PDF.js scan refusal is not a
text extraction success. LiteParse returning `EXECUTION_OK` is not proof of
OCR text on scanned pages.

## Release gates

- **G0 trusted revision:** CI of this isolated benchmark branch must pass,
  including synthetic-only negative GT tests. Merge and sync the bench worktree
  to exact reviewed SHA separately before a local run.
- **G1 immutable source:** only the uniquely matching original matrix report
  from GitHub run #38026320680 is accepted. Exactly four accepted native runs,
  two expected PDF.js scan refusals, exact manifest/sample SHA and page lineage.
- **G2 independent GT:** all three GT JSON sidecars exist, pass v2 schema,
  have nonempty annotated text and blocks, and are reviewed independently by
  two distinct reviewers for all three physical source pages. GT SHA is bound
  to the manifest source/subset SHA and page map. Missing/rejected => BLOCKED.
- **G3 evidence fidelity:** for the four accepted runs, `result.json` and
  `normalized.json` must be complete and coherent with the pinned matrix
  (`runId`, input SHA, parser mode, fixture, cold run, exit status, 3 pages).
  No parser re-execution or overwriting any old evidence.
- **G4 v2 evaluator:** all four runs must produce `EVALUATED` reports via
  the existing v2 evaluator; two scan refusals remain ungraded.
- **G5 product acceptance:** `MEASURED_PENDING_PRODUCT_ACCEPTANCE`
  is **NOT** quality acceptance. Review per-page recall, reading order, page
  binding, citation locators, figures/tables/formulas and OCR capability.
  Thresholds and shipping decisions require separate reviewed policies,
  before declaring any "winner", "quality PASS", or readiness to ingest books.

## Invocation (only when separately authorized)

In the pinned benchmark worktree after installation/sync and human review:

```powershell
Set-Location "D:\所有项目\90_Worktrees\AI-Cognitive-Studio-pdf-parser-benchmark\tools\pdf-parser-benchmark"
npx --no-install tsx scripts/regrade_real_book_quality.ts
```

A missing/invalid GT or contradictory source evidence emits only
`ACS_PDF_QUALITY_GATE_BLOCKED` and a nonzero exit; do not label it a
failed parser or an accuracy measurement. On successful preparation it emits
`ACS_PDF_QUALITY_EVIDENCE_READY` and writes a new, non-overwriting private
`real-book-quality-<time>-<pid>.json` report. It never edits the old run.
Detailed quality metrics, missing key markers, reviewer IDs and content are
private; **do not paste them into GitHub or chat**.

A future manually-dispatched, default-branch-only Windows workflow can drive
the pinned regrader with stdout/stderr redaction, but only after this branch is
merged/synced, GT is reviewed, and an explicit approval is obtained.
