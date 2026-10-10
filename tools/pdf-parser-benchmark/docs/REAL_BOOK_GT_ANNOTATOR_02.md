# REAL-BOOK-GT-ANNOTATOR-02 — local source preview and blind machine comparison

## Status and authorization

This change is **code + synthetic tests only**. It is not proof that any private book
has been opened, rendered, annotated, OCR-processed, independently reviewed, or scored.
Real-book quality remains **NOT_MEASURED**.

The **02** UI extends the 01 human transcriber. Do not bypass independent review:
machine normalized output is never Ground Truth, and an LCS text alignment is not
an accuracy metric. Two separate real human reviewers and the existing SHA-pinned
REAL-BOOK-QUALITY-01 certificate gate remain mandatory.

## Local-only use, after a separately approved local browser test

From the *already reviewed and safely synchronized* PDF worktree, run the existing
`node scripts/serve_gt_annotation.mjs`. The server binds random-port
`127.0.0.1`, checks Host and remote IP and serves **only** six fixed UI routes
(`/`, `/index.html`, `/app.mjs`, `/workspace.mjs`, `/review.mjs`, `/styles.css`).
No file request path, POST, upload, API, private-data-root lookup, scanner, OCR,
parser, database, model or telemetry endpoint exists. CSP retains
`connect-src 'none'`, `object-src 'none'`; only a sandboxed `blob:` frame is
allowed for a user-selected PDF. No third-party assets.

1. Select `RB-PDF-11`, `12`, or `13`. The fixed **source physical page**
   map is respectively `RB-PDF-01: 22, 107, 192`,
   `RB-PDF-02: 73, 145, 261`, and `RB-PDF-03: 51, 127, 379`.
   The internal sub-document indices are `0, 1, 2`, **not** original book pages.
2. **Optional private title mapping**: click *读取本机书名映射* and manually choose
   the previously created private `real_book_selection.json`. The file must have
   `schema_version=acs-real-book-fixtures-v1` and valid entries with
   `id, format, archive_member, sha256, pages, bytes` for all 3 originals.
   It displays only the basenames; it does not modify the 01 draft schema,
   candidate GT, Git source, browser storage or a network service.
   Neither a source title nor a path is present in the Git repository.
3. **Optional source PDF**: click *选择本机原书 PDF* and explicitly select the
   corresponding **full original** `RB-PDF-01.pdf` / `02.pdf` / `03.pdf`,
   or the matching original basename from the selected private book mapping.
   The browser checks the filename, size (when mapping exists), and PDF magic
   header. This is **not a SHA-256 attestation**. A separate private manifest
   and exact file SHA are required before provenance can be trusted.
   The built-in PDF viewer navigates with `#page=<original 1-based page>`.
   Its page-fragment support depends on Chrome/Edge/browser PDF integration:
   if the viewer fails, use an external local PDF reader and manually check
   the original *physical* page. Never mistake printed page labels for these IDs.
   Switching samples or closing preview revokes the file's blob URL.
4. **Machine candidate**: click *导入已有机器候选*, and manually select a
   completed, pre-existing private `normalized.json` under the local benchmark
   `outputs/<fixtureId>/<parser>/runs/<runId>/` tree. The UI accepts at most
   four candidates in memory per sample. It checks `fixtureId`, page containers
   `0,1,2`, block binding, size bounds and the normalized page/blocks contract.
   **No OCR/model is run**; OCR availability is displayed only as claimed in
   `normalized.ocr`, with unknown or absent facts labeled as such. Unknown
   block-level page bindings are counted and warned, not invented. Import does
   **not** verify result.json, immutable SHA, model version, original source
   identity, execution success, or candidate run provenance. Failed/partial
   outputs must not be treated as accepted evidence. This UI deliberately
   labels them `UNVERIFIED_LOCAL_CANDIDATE` until a separately authorized
   evidence reader and exact SHA validation exists.
5. **Independent human transcription first**: without looking at machine
   output, transcribe all three physical pages from the original, edit the
   reading order, structure, table TSV, formulas, markers and OCR-required
   flags. Save a private draft, validate it, and **export the independent
   GT candidate JSON before revealing** a machine candidate. If using browser
   download fallback, confirm the file actually landed in the private D:
   directory — a download request is not proof of file durability.
6. **Seal and reveal**: choose an imported candidate and click *冻结当前 GT 并查看候选*.
   The UI prompts that GT was independently transcribed and saved, then seals
   the allowlisted v1 draft snapshot in memory and disables all editable
   fields/GT export. A changed draft fails the pure snapshot assertion.
   Only now does the page show exact normalized per-block alignment:
   `一致（仅文本）`, `人工有／候选未对齐`,
   `候选有／人工未对齐`, or `文字不同／待人工核对`. Non-exact blocks are paired by position between exact anchors for readability, **not** asserted equivalent. Neither mismatch nor equality is a quality score.
   The UI never copies machine candidate text into the GT editor.
   This is a **session-level workflow safeguard**, not a tamper-proof human
   independence attestation. Refreshing/resetting or using another browser
   cannot prove the operator remained blind; real independent reviewer
   attestations remain required.

## Security and limitations

- Reading source PDF/selection/candidate files occurs only after explicit
  browser file picker interactions, on the user's computer, not in GitHub
  Actions or during implementation. No server-side file reads outside the
  allowlisted checked-in UI, and no web requests or persistent browser storage.
- Imported metadata is allowlisted. Untrusted candidate text is written to
  DOM **textContent**, never `innerHTML`; candidate data is only held in
  memory, not included in draft/GT exports. Source PDF object URLs are revoked
  when samples change or preview closes. CSP permits only a sandboxed
  local `blob:` document frame (no same-origin privilege).
- Reading a PDF in an embedded browser is inherently dependent on its PDF
  viewer and may not work with sandboxing on all platforms. The fallback is
  **external local PDF reader**, not weakening CSP or permitting remote scripts.
- Matching a selected local file's name/size is **not cryptographic source
  validation**; no local title mapping or OCR candidate is automatically
  considered trustworthy. A verified native-OCR run is *not* the same thing as
  an accepted human GT.
- Do not commit, paste into chat or upload private filenames, PDF bytes,
  normalized outputs, OCR transcriptions, human GT, source metadata or
  full real-book SHA values.
- Browser user-interaction tests and actual private-file walkthrough are
  **pending**, and require separate explicit approval on the Windows host.
- The previously reported Phase-15 podcast claim/rearm integration timing
  flake is outside this isolated PDF annotation PR.

## Synthetic release gates

The cloud PDF synthetic workflow checks JS syntax for
`annotation/review.mjs`, runs prior 01 tests and the new
`tests/gt-annotation-review.test.mjs` (synthetic book names/text only).
The new test covers source-name limits/traversal, cross-book/page mismatch,
OCR unknowns, SHA-disclaimer semantics, read-only server access, blind
sealing, per-page alignment and exclusion of untrusted fields. Existing
`tests/real-book-quality-gate.test.ts` still fails closed without true
human reviews. Do not run any private PDF benchmark in cloud CI.
