import { ProviderGatewayError } from "../errors.js";
import type { ProtocolFamily } from "../types.js";
export type AuthScheme = "BEARER" | "X_API_KEY" | "X_GOOG_API_KEY";
export type ProviderProfile = { providerKey: "openai" | "anthropic" | "gemini" | "deepseek" | "qwen" | "minimax"; protocol: ProtocolFamily; endpoint: string; authScheme: AuthScheme; anthropicVersion?: string };
/** Endpoints are deployment-approved profiles, never user-controlled base URLs. */
export const builtInProviderProfiles: readonly ProviderProfile[] = [
  { providerKey: "openai", protocol: "OPENAI_RESPONSES", endpoint: "https://api.openai.com/v1/responses", authScheme: "BEARER" },
  { providerKey: "anthropic", protocol: "ANTHROPIC_COMPATIBLE", endpoint: "https://api.anthropic.com/v1/messages", authScheme: "X_API_KEY", anthropicVersion: "2023-06-01" },
  { providerKey: "gemini", protocol: "GEMINI_NATIVE", endpoint: "https://generativelanguage.googleapis.com/v1beta", authScheme: "X_GOOG_API_KEY" },
  { providerKey: "deepseek", protocol: "OPENAI_COMPATIBLE", endpoint: "https://api.deepseek.com/chat/completions", authScheme: "BEARER" },
  { providerKey: "qwen", protocol: "OPENAI_COMPATIBLE", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", authScheme: "BEARER" },
  { providerKey: "minimax", protocol: "OPENAI_COMPATIBLE", endpoint: "https://api.minimax.io/v1/chat/completions", authScheme: "BEARER" },
];
type QwenRegion = "BEIJING" | "SINGAPORE" | "US_VIRGINIA";
function qwenProfile(configuration: Readonly<Record<string, unknown>>): ProviderProfile | undefined {
  const region = configuration.qwenRegion as QwenRegion | undefined; const workspaceId = configuration.qwenWorkspaceId;
  if (region === "US_VIRGINIA") return { providerKey: "qwen", protocol: "OPENAI_COMPATIBLE", endpoint: "https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions", authScheme: "BEARER" };
  if ((region === "BEIJING" || region === "SINGAPORE") && typeof workspaceId === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(workspaceId)) { const location = region === "BEIJING" ? "cn-beijing" : "ap-southeast-1"; return { providerKey: "qwen", protocol: "OPENAI_COMPATIBLE", endpoint: `https://${workspaceId}.${location}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`, authScheme: "BEARER" }; }
  return undefined;
}
export function approvedProfile(providerKey: string, endpoint: string | undefined, configuration: Readonly<Record<string, unknown>> = {}): ProviderProfile | undefined { const profile = providerKey === "qwen" ? qwenProfile(configuration) : builtInProviderProfiles.find(item => item.providerKey === providerKey); return profile && (!endpoint || endpoint === profile.endpoint) ? profile : undefined; }
export function authHeaders(scheme: AuthScheme, credential: string | undefined): Record<string, string> { if (!credential) throw new ProviderGatewayError("AUTHENTICATION_FAILED"); return scheme === "BEARER" ? { authorization: `Bearer ${credential}` } : scheme === "X_API_KEY" ? { "x-api-key": credential } : { "x-goog-api-key": credential }; }
