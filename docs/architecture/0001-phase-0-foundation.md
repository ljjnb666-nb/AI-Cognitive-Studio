# ADR 0001: Phase 0 foundation

## Status

Accepted.

## Decision

The repository uses a pnpm workspace monorepo. Next.js provides the Web and BFF boundary, while a separate TypeScript worker consumes BullMQ jobs from Redis. PostgreSQL with Prisma owns durable relational data. Zod validates inputs and environment configuration; Vitest covers unit and integration checks, and Playwright validates the Web surface.

`packages/domain`, `packages/shared`, and `packages/db` centralize cross-application contracts, infrastructure utilities, and database access respectively. This prevents divergent error, environment, Redis, and Prisma implementations.

## Consequences

Phase 0 contains a Web health page, `GET /api/health`, the `system.health-check` queue job, baseline data models, test isolation, and CI. AI, document, podcast, and video modules will be added in later phases only; no placeholder agents or product APIs are included now.
