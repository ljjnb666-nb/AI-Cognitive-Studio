# AI Cognitive Studio

AI Cognitive Studio is a future platform for deep book understanding and content creation. Phase 1 establishes the server-only source ingestion foundation; AI and product workflows remain out of scope.

## Architecture

- `apps/web`: Next.js App Router application and health endpoint.
- `apps/worker`: BullMQ worker containing only the Phase 0 health-check job.
- `packages/db`: Prisma schema, migration, and shared Prisma client.
- `packages/domain`: Zod schemas and the shared `AppError` model.
- `packages/shared`: environment validation, structured logger, and Redis connection factory.
- `packages/storage`: private S3-compatible object storage abstraction.
- `packages/ingestion`: upload intent, immutable source identity, parsing, and outbox-backed ingestion orchestration.

## Local Setup

```bash
pnpm install
docker compose up -d
Copy-Item .env.example .env
# Generate and set a value of at least 32 bytes for BETTER_AUTH_SECRET.
# The repository-root .env is the only local-development environment file.
pnpm db:generate
pnpm db:migrate
pnpm dev
```

`pnpm dev`, `pnpm dev:web`, and `pnpm dev:worker` load the repository-root
`.env`. Do not create duplicate `apps/web/.env.local` or `apps/worker/.env`
files. CI and production supply configuration through their process environment;
those explicit values take precedence over values in a local `.env` file.

`pnpm db:migrate` is the local development command. It runs `prisma migrate dev`, which creates and applies a development migration when the Prisma schema changes. Do not use it in CI or deployment.

For CI and deployment, apply only checked-in migrations:

```bash
pnpm db:migrate:deploy
```

`pnpm db:migrate:deploy` runs `prisma migrate deploy`; it never creates a new migration.

The compose stack includes PostgreSQL, Redis, and MinIO. `minio-init` idempotently creates the private development bucket and applies a local-only CORS policy for browser PUT and HEAD requests from `http://localhost:3000`. The S3 credentials in `.env.example` are local-development-only dummy values; production requires separately managed secrets and rejects known dummy credential values. `S3_ENDPOINT` is used by server-side storage calls; `S3_PUBLIC_ENDPOINT` is optional and is used only to create presigned browser URLs. File ingestion is invoked through trusted server-side service calls until authentication is implemented, so there is intentionally no public upload endpoint.

The integration suite uses `DATABASE_URL_TEST`. Create the test database once after containers start:

```bash
docker compose exec postgres createdb -U app ai_cognitive_studio_test
```

Then apply the checked-in migration to it:

```bash
$env:DATABASE_URL = (Select-String '^DATABASE_URL_TEST=' .env).Line.Split('=', 2)[1]
pnpm db:migrate:deploy
```

## Validation

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Out of Phase 0 Scope

Authentication, uploads, document processing, AI features, podcasts, video, payments, and product routes remain intentionally unimplemented.
