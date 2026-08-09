import { createHash, createHmac } from "node:crypto";

export type ObjectHead = { key: string; size: number; contentType?: string };
export type PutObjectInput = { key: string; body: Uint8Array; contentType: string };
export type StorageProvider = {
  createPresignedUpload(input: { key: string; contentType: string; expiresInSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
  headObject(key: string): Promise<ObjectHead | null>;
  getObjectBytes(key: string): Promise<Uint8Array>;
  putObject(input: PutObjectInput): Promise<void>;
  copyObject(sourceKey: string, targetKey: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  objectExists(key: string): Promise<boolean>;
};

export type S3Config = { endpoint: string; region: string; bucket: string; accessKey: string; secretKey: string; forcePathStyle: boolean };
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/");

export class S3CompatibleStorageProvider implements StorageProvider {
  constructor(private readonly config: S3Config) {}

  async createPresignedUpload({ key, contentType, expiresInSeconds }: { key: string; contentType: string; expiresInSeconds: number }) {
    const url = this.url(key); const now = new Date(); const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); const day = stamp.slice(0, 8);
    const host = url.host; const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const query = new URLSearchParams({ "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${this.config.accessKey}/${scope}`, "X-Amz-Date": stamp, "X-Amz-Expires": String(expiresInSeconds), "X-Amz-SignedHeaders": "content-type;host" });
    const canonical = `PUT\n${url.pathname}\n${query.toString().replace(/%2F/g, "/")}\ncontent-type:${contentType}\nhost:${host}\n\ncontent-type;host\nUNSIGNED-PAYLOAD`;
    const signingKey = this.signingKey(day); const signature = createHmac("sha256", signingKey).update(`AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha256(canonical)}`).digest("hex");
    query.set("X-Amz-Signature", signature); url.search = query.toString(); return { url: url.toString(), headers: { "content-type": contentType } };
  }
  async headObject(key: string): Promise<ObjectHead | null> { const response = await this.request("HEAD", key); if (response.status === 404) return null; if (!response.ok) throw new Error(`STORAGE_HEAD_FAILED:${response.status}`); return { key, size: Number(response.headers.get("content-length") ?? 0), contentType: response.headers.get("content-type") ?? undefined }; }
  async getObjectBytes(key: string): Promise<Uint8Array> { const response = await this.request("GET", key); if (!response.ok) throw new Error(`STORAGE_GET_FAILED:${response.status}`); return new Uint8Array(await response.arrayBuffer()); }
  async putObject(input: PutObjectInput): Promise<void> { const response = await this.request("PUT", input.key, input.body, { "content-type": input.contentType }); if (!response.ok) throw new Error(`STORAGE_PUT_FAILED:${response.status}`); }
  async copyObject(sourceKey: string, targetKey: string): Promise<void> { const response = await this.request("PUT", targetKey, undefined, { "x-amz-copy-source": `/${this.config.bucket}/${encodeKey(sourceKey)}` }); if (!response.ok) throw new Error(`STORAGE_COPY_FAILED:${response.status}`); }
  async deleteObject(key: string): Promise<void> { const response = await this.request("DELETE", key); if (!response.ok && response.status !== 404) throw new Error(`STORAGE_DELETE_FAILED:${response.status}`); }
  async objectExists(key: string) { return (await this.headObject(key)) !== null; }
  private url(key: string) { const endpoint = new URL(this.config.endpoint); return new URL(this.config.forcePathStyle ? `/${this.config.bucket}/${encodeKey(key)}` : `/${encodeKey(key)}`, this.config.forcePathStyle ? endpoint : `${endpoint.protocol}//${this.config.bucket}.${endpoint.host}`); }
  private signingKey(day: string) { return hmac(hmac(hmac(hmac(`AWS4${this.config.secretKey}`, day), this.config.region), "s3"), "aws4_request"); }
  private async request(method: string, key: string, body?: Uint8Array, extraHeaders: Record<string, string> = {}) { const url = this.url(key); const now = new Date(); const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); const day = stamp.slice(0, 8); const payloadHash = sha256(body ?? ""); const headers = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": stamp, ...extraHeaders }; const sorted = Object.entries(headers).sort(([a],[b]) => a.localeCompare(b)); const canonicalHeaders = sorted.map(([k,v]) => `${k}:${v.trim()}\n`).join(""); const signedHeaders = sorted.map(([k]) => k).join(";"); const scope = `${day}/${this.config.region}/s3/aws4_request`; const canonical = `${method}\n${url.pathname}\n${url.searchParams.toString()}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`; const signature = createHmac("sha256", this.signingKey(day)).update(`AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha256(canonical)}`).digest("hex"); const authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`; return fetch(url, { method, headers: { ...headers, authorization }, body: body ? Buffer.from(body) : undefined, redirect: "error" }); }
}
