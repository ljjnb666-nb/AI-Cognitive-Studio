import { z } from "zod";

const environmentSchema = z.object({
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
  WORKER_INGESTION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  WORKER_BOOK_ANALYSIS_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  WORKER_PODCAST_GENERATION_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  WORKER_AUDIO_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  WORKER_SHORT_VIDEO_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  OUTBOX_DISPATCH_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  SOURCE_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(104857600),
  SOURCE_MAX_PDF_PAGES: z.coerce.number().int().positive().default(2000),
  SOURCE_PARSE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
  }
  return environment;
}
