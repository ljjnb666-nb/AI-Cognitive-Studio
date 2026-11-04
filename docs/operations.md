# Operations

## Build and deploy

`Dockerfile` builds a single Web/Worker image as the unprivileged `node` user, pins the Node base digest and pnpm version, installs FFmpeg and CJK fonts, and uses the frozen dependency lockfile. Runtime secrets and local artifacts are excluded from the build context. The image currently retains workspace sources and development dependencies because the Worker executes TypeScript; reducing image size is a subsequent optimization. Debian packages resolve at build time, so archive the tested image digest rather than assuming future rebuilds are byte-identical.

```sh
docker build -t registry.example/ai-cognitive-studio:REVISION .
# Scan and test this image, then push it and record its immutable digest.
export ACS_IMAGE=registry.example/ai-cognitive-studio@sha256:TESTED_DIGEST
export ACS_ENV_FILE=/absolute/protected/production.env
# Quiesce workers and traffic; take and verify backups before migrations.
docker compose -f compose.production.yml --profile migration run --rm migrate
docker compose -f compose.production.yml up -d web worker
```

The production Compose file requires externally provisioned PostgreSQL, Redis and a private S3 bucket. Put an HTTPS reverse proxy in front of Web; it binds only to loopback on the host. Set `BETTER_AUTH_URL`, exact trusted origins, a random auth secret, a persistent `PROVIDER_GATEWAY_KEYRING`, S3 credentials and SMTP configuration. Disable all test/development escape hatches. Apply private bucket and exact-origin browser PUT/HEAD CORS policies on the storage service.

Do not generate a fresh credential keyring on restart. Losing any active or historical encryption key makes corresponding saved credentials unrecoverable. Store secrets outside the repository/image and back up key versions separately with restricted access. SMTP delivery failures expose only `AUTH_MAIL_DELIVERY_FAILED` in logs, never reset links or credentials.

Migrations run explicitly, once, before application rollout. They are not hidden in Web/Worker startup. Do not use `migrate dev` in production. For rollback, retain the previous image and schema-compatible backup; a code rollback does not automatically reverse database migrations.

Web health: `/api/health` is liveness; `/api/readiness` checks database, Redis and the object bucket with bounded probes. Monitor Worker heartbeat/queue age and failed jobs separately; Web readiness does not certify Worker or AI provider health. Worker SIGTERM drains active work; Compose allows ten minutes before forced termination. For longer jobs, drain admission first and increase the grace period based on measured job duration.

## Isolated image verification

After building, set `ACS_IMAGE` to that exact image and run `pnpm ops:verify-container`. The smoke runner creates a private Docker network and dedicated PostgreSQL/Redis/MinIO containers without host ports, applies all migrations, checks Web readiness and the non-root user, and verifies Worker and Web SIGTERM completion. It removes only its own containers/network and deletes its temporary credential file. Reports and logs remain under ignored `output/container-smoke/`. The pinned Next version intentionally exits 143 after SIGTERM; acceptance also requires its cleanup-completed log, so an abrupt kill is not accepted. This check does not contact external AI providers.

Run large builds and database suites sequentially on memory-constrained hosts. An interrupted or out-of-memory run is not a successful gate.

## Backup and restoration

Back up PostgreSQL, **all private object data**, application configuration, and **every keyring version** as one recoverable set. A database-only backup cannot recover media or encrypted provider credentials. Encrypt and restrict backup storage; retain a tested restore point before migration.

The local rehearsal deliberately targets only an isolated test database:

```powershell
$env:DATABASE_URL_TEST='postgresql://app:app@localhost:5432/ai_cognitive_studio_test?schema=public'
$env:RESTORE_COMPOSE_PROJECT='ai-cognitive-studio'
pnpm ops:restore-rehearsal
```

Stop other writers to that test database first. The script creates a unique restore database, verifies every public table row count, decrypts a synthetic credential using a backed-up synthetic key, and restores/checksums a synthetic S3 object. It never restores over the source database. Temporary database, canary table and objects are removed; the dump, synthetic key and report remain in ignored `output/restore/<id>/` for inspection. Protect these artifacts: the database dump contains the selected test database's full contents.

This rehearsal is not a complete production object-bucket backup or an RPO/RTO guarantee. Rehearse against a production-sized isolated copy with the actual encrypted backup/keyring restoration procedure before claiming recovery targets.

## Release gates and compatibility

Require the existing exact-head `validate` CI check on the default branch, disallow force pushes/deletion, and require review. Repository settings must be verified in GitHub; this document does not enable branch protection. Keep PRs unmerged until the tested commit and required checks match.

The audit changes add upload-cleanup receipts, resource-budget tables and a SQL cosine function. Deploy all checked-in migrations. New default book analysis uses `product-v2-evidence`; PDF native parsing uses `pdf-isolation-v4-layout`. Existing artifacts keep their historical provenance. Text calls now canonicalize the default output-token limit into the request fingerprint: changed request identities must fail closed rather than consume an incompatible historical receipt. Reconcile unresolved paid calls before any intentional regeneration.

Core unit/integration suites discover new test files automatically. Worker phase-specific E2E suites and the opt-in FFmpeg diagnostic/stress suites remain separate gates. Review both PASS and SKIP counts. Real-model semantic quality, representative PDF accuracy and production load are still independent acceptance requirements.
