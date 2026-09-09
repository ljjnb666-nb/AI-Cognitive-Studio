# Phase 18 closed beta production hardening

## Operational model

`/api/health` is liveness only. `/api/readiness` checks PostgreSQL, Redis and the configured object-storage bucket; it returns only dependency classifications and never connection strings, credentials, source text or provider responses. Provider availability remains a Provider Gateway concern and never makes the Studio process unhealthy.

Structured logs redact authorization, cookies, credentials, keyrings, tokens and secret-shaped values recursively. Operator diagnostics select only job state, age, attempts and a bounded failure code after proving workspace membership. They never select job payloads or raw error objects.

Expensive work admission (book analysis, podcast and short-video generation) uses PostgreSQL `pg_advisory_xact_lock` inside the same transaction that counts queued/running jobs and creates the job. The default workspace bound is two and is configured by `WORKSPACE_EXPENSIVE_OPERATION_LIMIT` (1–16). This is intentionally not a billing system.

## Backup and restore

PostgreSQL backups must be consistent logical or physical backups of the same deployment boundary. Restore into an isolated database, deploy the current forward-only migrations twice, validate application reads and the current artifact pointers, then switch traffic only after verification. Never use a rollback migration to destroy newer production data.

Object storage artifacts are immutable, content-addressed/pinned database references. Back up the bucket with versioning/retention appropriate to the deployment. Reconcile orphan objects by comparing storage keys to durable artifact rows; do not delete an object merely because a transient worker failed.

## Deploy and rollback

Deploy order is: additive database migration, compatible worker, then web. This preserves the transaction/outbox contract when web begins creating jobs. Application rollback is permitted only while the earlier application version remains compatible with the forward schema. Data/schema recovery is a separately approved restore procedure, not an automatic down migration.

## Governance risk

As audited for Phase 18, `main` has no branch protection. Recommended repository administration (not changed by this Phase): PR-only changes, required exact-head CI, and prevention of force pushes and deletion of `main`.
