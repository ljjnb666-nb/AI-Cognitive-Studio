import { randomUUID } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { S3CompatibleStorageProvider } from "../src/index.js";

const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT ?? "http://localhost:9000";
const bucket = process.env.S3_BUCKET ?? "ai-cognitive-studio-dev";
const provider = new S3CompatibleStorageProvider({
  endpoint,
  publicEndpoint,
  region: process.env.S3_REGION ?? "us-east-1",
  bucket,
  accessKey: process.env.S3_ACCESS_KEY ?? "local-development-only",
  secretKey: process.env.S3_SECRET_KEY ?? "local-development-only",
  forcePathStyle: true,
});
const prefix = `tests/storage/${randomUUID()}`;
const createdKeys = new Set<string>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function key(name: string): string {
  const value = `${prefix}/${name}`;
  createdKeys.add(value);
  return value;
}

afterAll(async () => {
  await Promise.all([...createdKeys].map((objectKey) => provider.deleteObject(objectKey).catch(() => undefined)));
});

describe("S3CompatibleStorageProvider against MinIO", () => {
  it("streams, copies, deletes, and supports a browser-style presigned upload", async () => {
    expect(await provider.bucketExists()).toBe(true);
    await expect(provider.createPresignedUpload({ key: " ", contentType: "text/plain", expiresInSeconds: 60 })).rejects.toThrow("STORAGE_INVALID_KEY");
    await expect(provider.createPresignedUpload({ key: "tests/ttl.txt", contentType: "text/plain", expiresInSeconds: 0 })).rejects.toThrow("STORAGE_INVALID_PRESIGN_TTL");
    await expect(provider.createPresignedUpload({ key: "tests/ttl.txt", contentType: "text/plain", expiresInSeconds: 604_801 })).rejects.toThrow("STORAGE_INVALID_PRESIGN_TTL");

    const originalKey = key("original.txt");
    const copiedKey = key("copied.txt");
    const uploadedKey = key("uploaded.txt");
    const rejectedKey = key("rejected.txt");
    const payload = encoder.encode("streamed storage payload");

    await provider.putObject({ key: originalKey, body: payload, contentType: "text/plain" });
    expect(await provider.headObject(originalKey)).toMatchObject({ key: originalKey, size: payload.length, contentType: "text/plain" });

    const chunks: Uint8Array[] = [];
    for await (const chunk of await provider.getObjectStream(originalKey)) chunks.push(chunk);
    expect(decoder.decode(Buffer.concat(chunks))).toBe("streamed storage payload");
    expect(decoder.decode(await provider.getObjectBytes(originalKey))).toBe("streamed storage payload");

    await provider.copyObject(originalKey, copiedKey);
    expect(decoder.decode(await provider.getObjectBytes(copiedKey))).toBe("streamed storage payload");

    const upload = await provider.createPresignedUpload({ key: uploadedKey, contentType: "text/plain", expiresInSeconds: 60 });
    expect(new URL(upload.url).host).toBe(new URL(publicEndpoint).host);
    const preflightResponse = await fetch(upload.url, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflightResponse.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const uploadResponse = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: encoder.encode("presigned payload") });
    expect(uploadResponse.ok).toBe(true);
    expect(decoder.decode(await provider.getObjectBytes(uploadedKey))).toBe("presigned payload");

    const invalidUpload = await provider.createPresignedUpload({ key: rejectedKey, contentType: "text/plain", expiresInSeconds: 60 });
    const invalidResponse = await fetch(invalidUpload.url, { method: "PUT", headers: { "content-type": "application/json" }, body: encoder.encode("wrong type") });
    expect(invalidResponse.ok).toBe(false);

    const unsignedGet = await fetch(`${publicEndpoint.replace(/\/$/, "")}/${bucket}/${uploadedKey}`);
    expect(unsignedGet.ok).toBe(false);

    await provider.deleteObject(copiedKey);
    await provider.deleteObject(copiedKey);
    expect(await provider.headObject(copiedKey)).toBeNull();
    expect(await provider.objectExists(copiedKey)).toBe(false);
  });
});
