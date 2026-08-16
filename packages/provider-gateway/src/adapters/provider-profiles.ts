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
export function approvedProfile(providerKey: string, endpoint: string | undefined): ProviderProfile | undefined { const profile = builtInProviderProfiles.find(item => item.providerKey === providerKey); return profile && (!endpoint || endpoint === profile.endpoint) ? profile : undefined; }
export function authHeaders(scheme: AuthScheme, credential: string | undefined): Record<string, string> { if (!credential) throw new ProviderGatewayError("AUTHENTICATION_FAILED"); return scheme === "BEARER" ? { authorization: `Bearer ${credential}` } : scheme === "X_API_KEY" ? { "x-api-key": credential } : { "x-goog-api-key": credential }; }
