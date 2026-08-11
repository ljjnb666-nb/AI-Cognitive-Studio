import { sha256 } from "./chunking.js";

export type EmbeddingIdentity = { provider: string; model: string; modelVersion?: string; embeddingVersion: string; dimensions: number };
export interface EmbeddingProvider { identity: EmbeddingIdentity; embed(input: { texts: string[]; model: string; correlationId: string }): Promise<number[][]> }
export function embeddingIdentityWithHash(identity: EmbeddingIdentity, embeddingVersion = identity.embeddingVersion) {
  if (!Number.isInteger(identity.dimensions) || identity.dimensions <= 0) throw new Error("EMBEDDING_IDENTITY_INVALID");
  return { ...identity, embeddingVersion, hash: sha256(JSON.stringify([identity.provider, identity.model, identity.modelVersion ?? "", embeddingVersion, identity.dimensions])) };
}
export class DeterministicFakeEmbeddingProvider implements EmbeddingProvider { readonly identity = { provider: "deterministic-test", model: "deterministic-vector-v1", embeddingVersion: "deterministic-v1", dimensions: 4 }; async embed(input: { texts: string[] }): Promise<number[][]> { return input.texts.map((text) => { const v = [0, 0, 0, 0]; for (let i=0;i<text.length;i++) { const index = i % v.length; v[index] = (v[index]! + text.charCodeAt(i) * (i + 1)) % 997; } const length=Math.hypot(...v) || 1; return v.map((n)=>n/length); }); } }
export const cosineSimilarity = (a: number[], b: number[]) => a.length === b.length ? a.reduce((sum, value, index) => sum + value * b[index]!, 0) : -Infinity;
