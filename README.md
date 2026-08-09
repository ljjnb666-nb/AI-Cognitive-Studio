# AI Cognitive Studio

AI Cognitive Studio is a future platform for deep book understanding and content creation. Phase 0 establishes only the engineering foundation; product workflows are deliberately out of scope.

## Architecture

- `apps/web`: Next.js App Router application and health endpoint.
- `apps/worker`: BullMQ worker containing only the Phase 0 health-check job.
- `packages/db`: Prisma schema, migration, and shared Prisma client.
- `packages/domain`: Zod schemas and the shared `AppError` model.
- `packages/shared`: environment validation, structured logger, and Redis connection factory.

## Local Setup

```bash
pnpm install
docker compose up -d
Copy-Item .env.example .env
pnpm db:generate
pnpm db:migrate
pnpm dev
```

The integration suite uses `DATABASE_URL_TEST`. Create the test database once after containers start:

```bash
docker compose exec postgres createdb -U app ai_cognitive_studio_test
```

Then apply the checked-in migration to it:

```bash
$env:DATABASE_URL = (Select-String '^DATABASE_URL_TEST=' .env).Line.Split('=', 2)[1]
pnpm --filter @ai-cognitive/db prisma migrate deploy
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
