import { ProviderGatewayError } from "./errors.js";
import type { CapabilityFamily, CapabilityRequest, ModelCapability, ProtocolFamily, ProviderDefinition } from "./types.js";

const structuredRank = { UNSUPPORTED: 0, PROMPT_ONLY: 1, JSON_MODE: 2, STRICT_JSON_SCHEMA: 3 } as const;
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDefinition>();
  register(definition: ProviderDefinition): void { if (!/^[a-z0-9][a-z0-9._-]*$/.test(definition.providerKey)) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Provider key must be a stable machine key"); if (this.providers.has(definition.providerKey)) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "Duplicate provider key"); this.providers.set(definition.providerKey, Object.freeze({ ...definition, models: Object.freeze([...definition.models]) })); }
  get(providerKey: string): ProviderDefinition | undefined { return this.providers.get(providerKey); }
  resolveProtocol(providerKey: string, family: CapabilityFamily): ProtocolFamily { const definition = this.get(providerKey); if (!definition) throw new ProviderGatewayError("MODEL_NOT_FOUND"); return definition.capabilityProtocols?.[family] ?? definition.protocol; }
  resolveCapability(providerKey: string, modelId: string, request: CapabilityRequest): ModelCapability { const model = this.get(providerKey)?.models.find(item => item.modelId === modelId); if (!model) throw new ProviderGatewayError("MODEL_NOT_FOUND"); if (!model.families.includes(request.family) || (request.structuredOutput && structuredRank[model.structuredOutput ?? "UNSUPPORTED"] < structuredRank[request.structuredOutput]) || (request.minimumInputTokens && (model.maxInputTokens ?? 0) < request.minimumInputTokens) || (request.minimumOutputTokens && (model.maxOutputTokens ?? 0) < request.minimumOutputTokens) || (request.outputFormat && !model.speechFormats?.includes(request.outputFormat))) throw new ProviderGatewayError("CAPABILITY_MISMATCH"); return model; }
}
