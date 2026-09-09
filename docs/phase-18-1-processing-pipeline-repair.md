# Phase 18.1 processing repair

Processing state is derived from durable `IngestionRun`, `BookAnalysisRun`, current extraction/intelligence, and the worker heartbeat. `NO_RUN` is `NOT_STARTED`, never `QUEUED`.

Uploads create the source, ingestion run, job, and source-ingestion outbox event in one transaction. Recovery is authenticated and tenant-scoped; it returns an existing active/succeeded run, or appends a new attempt and durable outbox event while preserving failed history.

The worker writes a TTL-bound, credential-free Redis heartbeat. The web product surface reports `AVAILABLE`, `DEGRADED`, or `UNKNOWN`; it does not expose Redis details, payloads, credentials, or stack traces. A long queued run becomes degraded only when the heartbeat is absent.

`pnpm dev` starts web and worker. `pnpm dev:web` starts only web and will therefore show a degraded background-processing state after the bounded stale window. `pnpm dev:worker` starts only workers.

Book-analysis worker enablement supports a Provider Gateway-capable runtime for Workspace BYOK. The legacy `BOOK_ANALYSIS_PROVIDER` remains supported but no longer silently suppresses a configured gateway worker. Provider selection remains run-pinned and workspace-scoped.

The processing heartbeat contains only booleans for ingestion, book analysis, podcast generation, podcast audio, and short-video generation. Podcast, audio, and short-video workers still retain their legacy process-level enablement because their production runtime composition has not yet been converted to a workspace-BYOK-independent capability. The heartbeat makes those disabled capabilities diagnosable to operators; it never exposes provider settings, credentials, payloads, or errors.
