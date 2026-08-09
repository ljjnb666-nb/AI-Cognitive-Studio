# ADR 0001: Phase 0 foundation

## Status

Accepted.

## Decision

The repository uses a pnpm workspace monorepo. Next.js provides the Web and BFF boundary, while a separate TypeScript worker consumes BullMQ jobs from Redis. PostgreSQL with Prisma owns durable relational data. Zod validates inputs and environment configuration; Vitest covers unit and integration checks, and Playwright validates the Web surface.

`packages/domain`, `packages/shared`, and `packages/db` centralize cross-application contracts, infrastructure utilities, and database access respectively. This prevents divergent error, environment, Redis, and Prisma implementations. Web and Worker never import each other; the domain package has no framework or infrastructure dependency. Shared server infrastructure is exposed only from `@ai-cognitive/shared/server`, so `DATABASE_URL` and `REDIS_URL` cannot enter a Client Component bundle.

PostgreSQL `Job` is the durable source of truth for a business task lifecycle. BullMQ is execution infrastructure only. `queueJobId` links their records and allows recovery-oriented handling of retries, duplicate enqueue attempts, worker crashes, stalled jobs, and interrupted DB updates in later phases. `idempotencyKey` is unique when supplied; system jobs may have a null `userId` and do not require fake users.

All backend and database timestamps are UTC. Future UI layers are responsible for locale and timezone presentation; Phase 0 does not implement user-timezone behavior.

## Consequences

Phase 0 contains a Web health page, `GET /api/health`, the `system.health-check` queue job, baseline data models, test isolation, and CI. Redis connections share a single configuration and factory, but Queue, QueueEvents, and Worker hold lifecycle-appropriate physical connections. AI, document, podcast, and video modules will be added in later phases only; no placeholder agents or product APIs are included now.
