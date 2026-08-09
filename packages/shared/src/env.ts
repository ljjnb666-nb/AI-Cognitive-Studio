import { z } from "zod";

const environmentSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  S3_ENDPOINT: z.url().default("http://localhost:9000"),
  S3_REGION: z.string().min(1).default("us-east-1"),
  S3_BUCKET: z.string().min(1).default("ai-cognitive-studio-dev"),
  S3_ACCESS_KEY: z.string().min(1).default("local-development-only"),
  S3_SECRET_KEY: z.string().min(1).default("local-development-only"),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  SOURCE_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  SOURCE_MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(104857600),
  SOURCE_MAX_PDF_PAGES: z.coerce.number().int().positive().default(2000),
  SOURCE_PARSE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Environment = z.infer<typeof environmentSchema>;

export function readEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(source);
}
