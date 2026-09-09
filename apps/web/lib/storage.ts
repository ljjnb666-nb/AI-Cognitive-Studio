import { createS3CompatibleStorageProvider } from "@ai-cognitive/storage";
import { readEnvironment } from "@ai-cognitive/shared/server";

export function storage() {
  const environment = readEnvironment();
  return createS3CompatibleStorageProvider({
    endpoint: environment.S3_ENDPOINT,
    publicEndpoint: environment.S3_PUBLIC_ENDPOINT,
    region: environment.S3_REGION,
    bucket: environment.S3_BUCKET,
    accessKey: environment.S3_ACCESS_KEY,
    secretKey: environment.S3_SECRET_KEY,
    forcePathStyle: environment.S3_FORCE_PATH_STYLE,
  });
}
