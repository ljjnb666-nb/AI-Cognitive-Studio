import "server-only";

import { createS3CompatibleStorageProvider } from "@ai-cognitive/storage";

export function storage() {
  return createS3CompatibleStorageProvider({
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: process.env.S3_BUCKET ?? "ai-cognitive-studio-dev",
    accessKey: process.env.S3_ACCESS_KEY ?? "local-development-only",
    secretKey: process.env.S3_SECRET_KEY ?? "local-development-only",
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
  });
}
