# Phase 18.1 processing repair

Processing state is derived from durable `IngestionRun`, `BookAnalysisRun`, current extraction/intelligence, and the worker heartbeat. `NO_RUN` is `NOT_STARTED`, never `QUEUED`.

## Product state model

`NOT_STARTED` means the source exists without an ingestion run. `QUEUED_FOR_INGESTION`, `INGESTING`, `WAITING_FOR_ANALYSIS`, `ANALYSIS_QUEUED`, and `ANALYZING` are derived only from the newest durable run ordered by creation time. `SUCCEEDED` requires current immutable intelligence. Ingestion terminal errors become `INGESTION_FAILED`; analysis terminal errors become `ANALYSIS_FAILED`. A stale queued or running run becomes `PROCESSING_DEGRADED` only when the worker heartbeat is unavailable; a healthy worker may legitimately have a backlog.

The stale window uses `SOURCE_PARSE_TIMEOUT_MS`, rather than a UI-local magic timeout. The processing panel displays its durable waiting age, automatically backs off refresh from two seconds to ten seconds, pauses high-frequency work for hidden pages, clears timers on unmount, and stops automatic polling for terminal/degraded states.

Uploads create the source, ingestion run, job, and source-ingestion outbox event in one transaction. Recovery is authenticated and tenant-scoped; it returns an existing active/succeeded run, or appends a new attempt and durable outbox event while preserving failed history.

The source row is locked during recovery. Thus concurrent clicks converge on one active retry; recovery never mutates a failed run back to queued, overwrites a succeeded result, or writes directly to BullMQ from Web.

The worker writes a TTL-bound, credential-free Redis heartbeat. The web product surface reports `AVAILABLE`, `DEGRADED`, or `UNKNOWN`; it does not expose Redis details, payloads, credentials, or stack traces. A long queued run becomes degraded only when the heartbeat is absent.

The processing status endpoint is authenticated through the normal Web identity, filters by workspace ownership, and returns only product state, timestamps, statuses, recovery eligibility, worker availability, and a constrained `safeFailureCode`. It does not return database records, connection strings, raw errors, credentials, source content, prompts, or provider responses.

`pnpm dev` starts web and worker. `pnpm dev:web` starts only web and will therefore show a degraded background-processing state after the bounded stale window. `pnpm dev:worker` starts only workers.

## Release evidence

`pnpm test:phase18-1:release` binds its evidence to the checked-out (or CI-supplied exact) SHA. It includes the Phase 18 fresh-database/two-deploy regression, real PostgreSQL recovery idempotence, TTL heartbeat tests, derived-state tests, and the Phase 6 browser harness. The browser harness first uploads a real PDF without a worker, asserts the degraded recovery UI, then starts the real worker and verifies the same source reaches grounded intelligence on desktop and mobile.

Book-analysis worker enablement supports a Provider Gateway-capable runtime for Workspace BYOK. The legacy `BOOK_ANALYSIS_PROVIDER` remains supported but no longer silently suppresses a configured gateway worker. Provider selection remains run-pinned and workspace-scoped.

The processing heartbeat contains only booleans for ingestion, book analysis, podcast generation, podcast audio, and short-video generation. Podcast, audio, and short-video workers still retain their legacy process-level enablement because their production runtime composition has not yet been converted to a workspace-BYOK-independent capability. The heartbeat makes those disabled capabilities diagnosable to operators; it never exposes provider settings, credentials, payloads, or errors.
