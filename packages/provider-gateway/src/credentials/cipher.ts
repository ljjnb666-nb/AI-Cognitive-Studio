import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ProviderGatewayError } from "../errors.js";

export type CredentialAad = { workspaceId: string; connectionId: string; credentialVersionId: string; providerKey: string };
export type EncryptedCredential = { ciphertext: string; iv: string; authTag: string; keyVersion: string };
export interface CredentialCipher { encrypt(plaintext: string, aad: CredentialAad): EncryptedCredential; decrypt(value: EncryptedCredential, aad: CredentialAad): string; }
export type EmbeddingResultAad = { workspaceId: string; invocationId: string; attemptId: string; snapshotId: string; providerKey: string; modelId: string };
export interface EmbeddingResultCipher { encryptEmbeddingResult(plaintext: string, aad: EmbeddingResultAad): EncryptedCredential; decryptEmbeddingResult(value: EncryptedCredential, aad: EmbeddingResultAad): string; }
export type TextResultAad = EmbeddingResultAad;
export interface TextResultCipher { encryptTextResult(plaintext: string, aad: TextResultAad): EncryptedCredential; decryptTextResult(value: EncryptedCredential, aad: TextResultAad): string; }
export type SpeechResultAad = EmbeddingResultAad;
export interface SpeechResultCipher { encryptSpeechResult(plaintext: string, aad: SpeechResultAad): EncryptedCredential; decryptSpeechResult(value: EncryptedCredential, aad: SpeechResultAad): string; }
function aadBytes(aad: CredentialAad): Buffer { return Buffer.from(JSON.stringify([aad.workspaceId, aad.connectionId, aad.credentialVersionId, aad.providerKey])); }
function embeddingResultAadBytes(aad: EmbeddingResultAad): Buffer { return Buffer.from(JSON.stringify(["provider-embedding-result-v1", aad.workspaceId, aad.invocationId, aad.attemptId, aad.snapshotId, aad.providerKey, aad.modelId])); }
function textResultAadBytes(aad: TextResultAad): Buffer { return Buffer.from(JSON.stringify(["provider-text-result-v1", aad.workspaceId, aad.invocationId, aad.attemptId, aad.snapshotId, aad.providerKey, aad.modelId])); }
function speechResultAadBytes(aad: SpeechResultAad): Buffer { return Buffer.from(JSON.stringify(["provider-speech-result-v1", aad.workspaceId, aad.invocationId, aad.attemptId, aad.snapshotId, aad.providerKey, aad.modelId])); }
export class VersionedAesGcmCipher implements CredentialCipher {
  constructor(private readonly activeVersion: string, private readonly keys: ReadonlyMap<string, Buffer>) { if (!keys.has(activeVersion)) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Active credential key is unavailable"); for (const key of keys.values()) if (key.length !== 32) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Credential encryption keys must be 256-bit"); }
  encrypt(plaintext: string, aad: CredentialAad): EncryptedCredential { const key = this.keys.get(this.activeVersion); if (!key) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR"); const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aadBytes(aad)); return { ciphertext: Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), keyVersion: this.activeVersion }; }
  decrypt(value: EncryptedCredential, aad: CredentialAad): string { const key = this.keys.get(value.keyVersion); if (!key) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Unknown credential key version"); try { const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64")); decipher.setAAD(aadBytes(aad)); decipher.setAuthTag(Buffer.from(value.authTag, "base64")); return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8"); } catch { throw new ProviderGatewayError("AUTHORIZATION_FAILED", "Credential integrity validation failed"); } }
  encryptEmbeddingResult(plaintext: string, aad: EmbeddingResultAad): EncryptedCredential { return this.encryptWithAad(plaintext, embeddingResultAadBytes(aad)); }
  decryptEmbeddingResult(value: EncryptedCredential, aad: EmbeddingResultAad): string { try { return this.decryptWithAad(value, embeddingResultAadBytes(aad)); } catch { throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Embedding result integrity validation failed"); } }
  encryptTextResult(plaintext: string, aad: TextResultAad): EncryptedCredential { return this.encryptWithAad(plaintext, textResultAadBytes(aad)); }
  decryptTextResult(value: EncryptedCredential, aad: TextResultAad): string { try { return this.decryptWithAad(value, textResultAadBytes(aad)); } catch { throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Text result integrity validation failed"); } }
  encryptSpeechResult(plaintext: string, aad: SpeechResultAad): EncryptedCredential { return this.encryptWithAad(plaintext, speechResultAadBytes(aad)); }
  decryptSpeechResult(value: EncryptedCredential, aad: SpeechResultAad): string { try { return this.decryptWithAad(value, speechResultAadBytes(aad)); } catch { throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Speech result integrity validation failed"); } }
  private encryptWithAad(plaintext: string, aad: Buffer): EncryptedCredential { const key = this.keys.get(this.activeVersion); if (!key) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR"); const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad); return { ciphertext: Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64"), keyVersion: this.activeVersion }; }
  private decryptWithAad(value: EncryptedCredential, aad: Buffer): string { const key = this.keys.get(value.keyVersion); if (!key) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Unknown embedding result key version"); const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64")); decipher.setAAD(aad); decipher.setAuthTag(Buffer.from(value.authTag, "base64")); return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8"); }
}
export function parseKeyring(input: string | undefined): VersionedAesGcmCipher | undefined { if (!input) return undefined; let value: unknown; try { value = JSON.parse(input); } catch { throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Invalid provider gateway keyring"); } const record = value as { activeVersion?: unknown; keys?: unknown }; if (typeof record.activeVersion !== "string" || !record.keys || typeof record.keys !== "object") throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Invalid provider gateway keyring"); const keys = new Map(Object.entries(record.keys as Record<string, unknown>).map(([version, encoded]) => { if (typeof encoded !== "string") throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Invalid provider gateway key"); return [version, Buffer.from(encoded, "base64")]; })); return new VersionedAesGcmCipher(record.activeVersion, keys); }

/** Resolve the deployment keyring, or initialize one durable local-development key exactly when credentials are first saved. */
export function resolveCredentialKeyring(environment: { NODE_ENV?: string; PROVIDER_GATEWAY_KEYRING?: string; PROVIDER_GATEWAY_LOCAL_KEYRING_PATH?: string }, options: { initializeLocal?: boolean } = {}): VersionedAesGcmCipher | undefined {
  const configured = parseKeyring(environment.PROVIDER_GATEWAY_KEYRING);
  if (configured) return configured;
  if (environment.NODE_ENV === "production") return undefined;
  const path = resolve(environment.PROVIDER_GATEWAY_LOCAL_KEYRING_PATH ?? ".runtime/secrets/provider-gateway-keyring.json");
  if (existsSync(path)) return parseKeyring(readFileSync(path, "utf8"));
  if (!options.initializeLocal) return undefined;
  const encoded = randomBytes(32).toString("base64"), value = JSON.stringify({ activeVersion: "local-v1", keys: { "local-v1": encoded } });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { chmodSync(path, 0o600); } catch { /* Windows may not support POSIX mode bits. */ }
  process.emitWarning("A local Provider credential keyring was created. Keep .runtime/secrets intact; deleting it makes saved local API keys undecryptable.", { code: "PROVIDER_GATEWAY_LOCAL_KEYRING_CREATED" });
  return parseKeyring(value)!;
}
