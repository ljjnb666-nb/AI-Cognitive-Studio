import { ProviderGatewayError } from "../errors.js";
import type { CapabilityFamily, ProtocolFamily } from "../types.js";
export type AuthScheme = "BEARER" | "X_API_KEY" | "X_GOOG_API_KEY";
export type ProviderProfile = { providerKey: string; family: CapabilityFamily; protocol: ProtocolFamily; endpoint: string; authScheme: AuthScheme; anthropicVersion?: string };
/** Endpoints are deployment-approved profiles, never user-controlled base URLs. */
export const builtInProviderProfiles: readonly ProviderProfile[] = [
  { providerKey: "openai", family: "TEXT_GENERATION", protocol: "OPENAI_RESPONSES", endpoint: "https://api.openai.com/v1/responses", authScheme: "BEARER" },
  { providerKey: "openai", family: "EMBEDDING", protocol: "OPENAI_EMBEDDINGS", endpoint: "https://api.openai.com/v1/embeddings", authScheme: "BEARER" },
  { providerKey: "openai", family: "SPEECH", protocol: "CUSTOM_SPEECH", endpoint: "https://api.openai.com/v1/audio/speech", authScheme: "BEARER" },
  { providerKey: "anthropic", family: "TEXT_GENERATION", protocol: "ANTHROPIC_COMPATIBLE", endpoint: "https://api.anthropic.com/v1/messages", authScheme: "X_API_KEY", anthropicVersion: "2023-06-01" },
  { providerKey: "gemini", family: "TEXT_GENERATION", protocol: "GEMINI_NATIVE", endpoint: "https://generativelanguage.googleapis.com/v1beta", authScheme: "X_GOOG_API_KEY" },
  { providerKey: "gemini", family: "EMBEDDING", protocol: "GEMINI_EMBEDDINGS", endpoint: "https://generativelanguage.googleapis.com/v1beta", authScheme: "X_GOOG_API_KEY" },
  { providerKey: "deepseek", family: "TEXT_GENERATION", protocol: "OPENAI_COMPATIBLE", endpoint: "https://api.deepseek.com/chat/completions", authScheme: "BEARER" },
  { providerKey: "zhipu", family: "TEXT_GENERATION", protocol: "OPENAI_COMPATIBLE", endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", authScheme: "BEARER" },
  { providerKey: "qwen", family: "TEXT_GENERATION", protocol: "OPENAI_COMPATIBLE", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", authScheme: "BEARER" },
  { providerKey: "minimax", family: "TEXT_GENERATION", protocol: "OPENAI_COMPATIBLE", endpoint: "https://api.minimax.io/v1/chat/completions", authScheme: "BEARER" },
  { providerKey: "cohere", family: "EMBEDDING", protocol: "COHERE_EMBEDDINGS_V2", endpoint: "https://api.cohere.com/v2/embed", authScheme: "BEARER" },
  { providerKey: "voyage", family: "EMBEDDING", protocol: "VOYAGE_EMBEDDINGS", endpoint: "https://api.voyageai.com/v1/embeddings", authScheme: "BEARER" },
];
type QwenRegion = "BEIJING" | "SINGAPORE" | "US_VIRGINIA";
function qwenProfile(family: CapabilityFamily, configuration: Readonly<Record<string, unknown>>): ProviderProfile | undefined {
  const region = configuration.qwenRegion as QwenRegion | undefined; const workspaceId = configuration.qwenWorkspaceId;
  const suffix = family === "EMBEDDING" ? "embeddings" : family === "TEXT_GENERATION" ? "chat/completions" : undefined; if (!suffix) return undefined;
  if (region === "US_VIRGINIA" && family === "TEXT_GENERATION") return { providerKey: "qwen", family, protocol: "OPENAI_COMPATIBLE", endpoint: `https://dashscope-us.aliyuncs.com/compatible-mode/v1/${suffix}`, authScheme: "BEARER" };
  if ((region === "BEIJING" || region === "SINGAPORE") && typeof workspaceId === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workspaceId)) { const location = region === "BEIJING" ? "cn-beijing" : "ap-southeast-1"; return { providerKey: "qwen", family, protocol: "OPENAI_COMPATIBLE", endpoint: `https://${workspaceId}.${location}.maas.aliyuncs.com/compatible-mode/v1/${suffix}`, authScheme: "BEARER" }; }
  return undefined;
}
export function approvedProfile(providerKey: string, family: CapabilityFamily, endpoint: string | undefined, configuration: Readonly<Record<string, unknown>> = {}): ProviderProfile | undefined {
  if (providerKey === "openai-compatible" && family === "TEXT_GENERATION" && endpoint) return { providerKey, family, protocol: "OPENAI_COMPATIBLE", endpoint, authScheme: "BEARER" };
  const profile = providerKey === "qwen" ? qwenProfile(family, configuration) : builtInProviderProfiles.find(item => item.providerKey === providerKey && item.family === family);
  return profile && (!endpoint || endpoint === profile.endpoint) ? profile : undefined;
}
export function authHeaders(scheme: AuthScheme, credential: string | undefined): Record<string, string> { if (!credential) throw new ProviderGatewayError("AUTHENTICATION_FAILED"); return scheme === "BEARER" ? { authorization: `Bearer ${credential}` } : scheme === "X_API_KEY" ? { "x-api-key": credential } : { "x-goog-api-key": credential }; }
