import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export type ObjectHead = { key: string; size: number; contentType?: string };
export type PutObjectInput = { key: string; body: Uint8Array; contentType: string };
export type PresignedUpload = { url: string; headers: Record<string, string> };
export type StorageProvider = {
  createPresignedUpload(input: { key: string; contentType: string; expiresInSeconds: number }): Promise<PresignedUpload>;
  headObject(key: string): Promise<ObjectHead | null>;
  getObjectStream(key: string): Promise<AsyncIterable<Uint8Array>>;
  /** @deprecated Transitional compatibility method; migrate callers to getObjectStream. */
  getObjectBytes(key: string): Promise<Uint8Array>;
  putObject(input: PutObjectInput): Promise<void>;
  copyObject(sourceKey: string, targetKey: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
  bucketExists?(): Promise<boolean>;
};

export type S3Config = { endpoint: string; publicEndpoint?: string; region: string; bucket: string; accessKey: string; secretKey: string; forcePathStyle: boolean };
const MAX_PRESIGN_TTL_SECONDS = 7 * 24 * 60 * 60;

function assertKey(key: string): void {
  const hasControlCharacter = [...key].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!key.trim() || key.startsWith("/") || key.includes("\\") || hasControlCharacter) throw new Error("STORAGE_INVALID_KEY");
}
function isNotFound(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.name === "NotFound" || value.name === "NoSuchKey" || value.$metadata?.httpStatusCode === 404;
}
function createClient(config: S3Config, endpoint: string): S3Client {
  return new S3Client({ endpoint, region: config.region, forcePathStyle: config.forcePathStyle, credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey } });
}
function copySource(bucket: string, key: string): string { return `/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`; }

export class S3CompatibleStorageProvider implements StorageProvider {
  private readonly serverClient: S3Client;
  private readonly presignClient: S3Client;

  constructor(private readonly config: S3Config) {
    this.serverClient = createClient(config, config.endpoint);
    this.presignClient = createClient(config, config.publicEndpoint ?? config.endpoint);
  }

  async createPresignedUpload({ key, contentType, expiresInSeconds }: { key: string; contentType: string; expiresInSeconds: number }): Promise<PresignedUpload> {
    assertKey(key);
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0 || expiresInSeconds > MAX_PRESIGN_TTL_SECONDS) throw new Error("STORAGE_INVALID_PRESIGN_TTL");
    const url = await getSignedUrl(
      this.presignClient,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds, signableHeaders: new Set(["content-type"]) },
    );
    return { url, headers: { "content-type": contentType } };
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    assertKey(key);
    try { const result = await this.serverClient.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key })); return { key, size: result.ContentLength ?? 0, contentType: result.ContentType }; }
    catch (error) { if (isNotFound(error)) return null; throw error; }
  }

  async getObjectStream(key: string): Promise<AsyncIterable<Uint8Array>> {
    assertKey(key);
    const result = await this.serverClient.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    const body = result.Body as AsyncIterable<Uint8Array> | undefined;
    if (!body || !body[Symbol.asyncIterator]) throw new Error("STORAGE_STREAM_UNAVAILABLE");
    return body;
  }

  async getObjectBytes(key: string): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []; let length = 0;
    for await (const chunk of await this.getObjectStream(key)) { chunks.push(chunk); length += chunk.length; }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }

  async putObject(input: PutObjectInput): Promise<void> { assertKey(input.key); await this.serverClient.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: input.key, Body: input.body, ContentType: input.contentType })); }
  async copyObject(sourceKey: string, targetKey: string): Promise<void> { assertKey(sourceKey); assertKey(targetKey); await this.serverClient.send(new CopyObjectCommand({ Bucket: this.config.bucket, Key: targetKey, CopySource: copySource(this.config.bucket, sourceKey) })); }
  async deleteObject(key: string): Promise<void> { assertKey(key); await this.serverClient.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key })); }
  async objectExists(key: string): Promise<boolean> { return (await this.headObject(key)) !== null; }
  async bucketExists(): Promise<boolean> { try { await this.serverClient.send(new HeadBucketCommand({ Bucket: this.config.bucket })); return true; } catch (error) { if (isNotFound(error)) return false; throw error; } }
}

export function createS3CompatibleStorageProvider(config: S3Config): StorageProvider { return new S3CompatibleStorageProvider(config); }
