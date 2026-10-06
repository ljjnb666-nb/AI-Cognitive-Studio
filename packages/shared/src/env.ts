import { z } from "zod";

export const environmentSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  S3_ENDPOINT: z.url().default("http://localhost:9000"),
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(1).default("ai-cognitive-studio-dev"),
  S3_ACCESS_KEY: z.string().min(1).default("local-development-only"),
  S3_SECRET_KEY: z.string().min(1).default("local-development-only"),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  SOURCE_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  SOURCE_UPLOAD_COMPLETION_LEASE_MS: z.coerce.number().int().positive().default(900000),
  SOURCE_OUTBOX_LEASE_MS: z.coerce.number().int().positive().default(60000),
  SOURCE_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Single authority for bounded same-run ingestion execution retries. It feeds
  // BOTH the source-ingestion BullMQ queue attempts AND the PostgreSQL
  // Job.attemptCount claim guard. OUTBOX DISPATCH ATTEMPTS
  // (SOURCE_OUTBOX_MAX_ATTEMPTS) govern OutboxEvent -> BullMQ enqueue delivery
  // and are unrelated to ingestion PROCESSING attempts.
  SOURCE_INGESTION_PROCESS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  WORKER_INGESTION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  WORKER_BOOK_ANALYSIS_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  WORKER_PODCAST_GENERATION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  WORKER_AUDIO_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  WORKER_SHORT_VIDEO_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  OUTBOX_DISPATCH_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  SOURCE_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(104857600),
  SOURCE_MAX_PDF_PAGES: z.coerce.number().int().positive().default(2000),
  SOURCE_PARSE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  // Real PDF OCR executor (BOOK-INGESTION-04B-3). Everything is optional:
  // an unconfigured environment keeps the 04B-2 no-OCR behavior. Cross-field
  // validation (provider=mineru requires local model source + existing model
  // root; tier pinned to flash) lives in the ingestion MinerU config resolver,
  // which fails fast at worker startup.
  OCR_PROVIDER: z.enum(["mineru"]).optional(),
  OCR_HOST_ID: z.string().min(1).optional(),
  MINERU_EXECUTABLE: z.string().min(1).optional(),
  // JSON array of fixed argv prefixed to every MinerU child invocation (e.g.
  // ["C:\\venv\\Scripts\\python.exe","-m","mineru"]). Malformed JSON fails fast
  // via the ingestion config resolver. Never accepts runtime/user input.
  MINERU_EXECUTABLE_ARGS: z.string().optional(),
  MINERU_MODEL_SOURCE: z.enum(["local"]).optional(),
  MINERU_MODEL_PATH: z.string().min(1).optional(),
  MINERU_TIER: z.enum(["flash"]).optional(),
  // Recognized but deliberately UNUSED for provenance: the production MinerU
  // version is pinned to 4.0.3 and verified against the runtime at startup
  // (RF01 P1-08). An operator-declared value never reaches parserVersion.
  MINERU_VERSION: z.string().min(1).optional(),
  MINERU_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  MINERU_SERVER_START_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  MINERU_SERVER_STOP_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  MINERU_HOME_ROOT: z.string().min(1).optional(),
  MINERU_MAX_OUTPUT_BYTES: z.coerce.number().int().positive().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  BETA_ACCESS_MODE: z.enum(["OFF", "ENFORCED"]).default("OFF"),
  WORKSPACE_EXPENSIVE_OPERATION_LIMIT: z.coerce.number().int().min(1).max(16).default(2),
});

export type Environment = z.infer<typeof environmentSchema>;

export function readEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const environment = environmentSchema.parse(source);
  if (environment.NODE_ENV === "production") {
    const required = ["S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"] as const;
    for (const key of required) if (!source[key]?.trim()) throw new Error(`MISSING_PRODUCTION_${key}`);
    for (const key of ["S3_ACCESS_KEY", "S3_SECRET_KEY"] as const) {
      if (/^(?:local(?:[-_].*)?|dummy(?:[-_].*)?|example(?:[-_].*)?|changeme|minioadmin)$/i.test(source[key] ?? "")) throw new Error(`UNSAFE_PRODUCTION_${key}`);
    }
    const authSecret = source.BETTER_AUTH_SECRET?.trim();
    if (!authSecret || authSecret.length < 32 || /(?:default|dummy|example|local|test|changeme)/i.test(authSecret)) throw new Error("UNSAFE_PRODUCTION_BETTER_AUTH_SECRET");
    const authUrl = source.BETTER_AUTH_URL?.trim();
    if (!authUrl || !/^https:\/\//i.test(authUrl)) throw new Error("UNSAFE_PRODUCTION_BETTER_AUTH_URL");
    if (source.BETA_PROVIDER_UX_TEST_CONNECTION_TRANSPORT || source.PROVIDER_GATEWAY_LOCAL_KEYRING_PATH || source.WEB_DEV_BOOTSTRAP_IDENTITY === "true" || source.THINKING_SESSION_TEST_GATEWAY === "true") throw new Error("UNSAFE_PRODUCTION_TEST_ESCAPE_HATCH");
    if (!source.PROVIDER_GATEWAY_KEYRING?.trim()) throw new Error("MISSING_PRODUCTION_PROVIDER_GATEWAY_KEYRING");
  }
  return environment;
}
