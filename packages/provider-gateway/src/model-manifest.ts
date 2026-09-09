import { ProviderGatewayError } from "./errors.js";
import { ProviderRegistry } from "./registry.js";
import type { CapabilityFamily, ModelCapability, ProviderDefinition, ProtocolFamily, RouteSlot } from "./types.js";

export type ProviderModelManifest = { providers: readonly ProviderDefinition[] };
export type SanitizedProviderManifest = { providers: readonly { providerKey: string; displayName: string; protocol: ProtocolFamily; capabilityProtocols?: Partial<Record<CapabilityFamily, ProtocolFamily>>; models: readonly ModelCapability[] }[] };

export const routeSlotCapabilities: Readonly<Record<RouteSlot, CapabilityFamily>> = {
  BOOK_CHUNK_ANALYSIS: "TEXT_GENERATION",
  BOOK_REDUCTION_ANALYSIS: "TEXT_GENERATION",
  BOOK_SYNTHESIS: "TEXT_GENERATION",
  EMBEDDING: "EMBEDDING",
  PODCAST_SCRIPT: "TEXT_GENERATION",
  PODCAST_TTS: "SPEECH",
  SHORT_VIDEO_SCRIPT: "TEXT_GENERATION",
  SHORT_VIDEO_TTS: "SPEECH",
  THINKING_SESSION: "TEXT_GENERATION",
  TEACH_BACK_ASSESSMENT: "TEXT_GENERATION",
};

export function parseProviderModelManifest(source: string | undefined): ProviderModelManifest {
  if (!source) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "PROVIDER_GATEWAY_MODEL_MANIFEST_MISSING");
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID"); }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as ProviderModelManifest).providers)) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID");
  const registry = new ProviderRegistry();
  for (const provider of (raw as ProviderModelManifest).providers) {
    if (!provider || typeof provider !== "object" || !provider.providerKey || !provider.displayName || !provider.protocol || !provider.adapterVersion || !Array.isArray(provider.models) || !provider.models.every(validModel)) throw new ProviderGatewayError("INTERNAL_PROVIDER_ERROR", "PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID");
    registry.register(provider);
  }
  return { providers: (raw as ProviderModelManifest).providers };
}

function validModel(model: ModelCapability): boolean {
  return Boolean(model && model.modelId && Array.isArray(model.families) && model.families.length && typeof model.confidence === "string");
}

export function sanitizedProviderManifest(manifest: ProviderModelManifest): SanitizedProviderManifest {
  return { providers: manifest.providers.map(({ providerKey, displayName, protocol, capabilityProtocols, models }) => ({ providerKey, displayName, protocol, capabilityProtocols, models })) };
}

export function validateRouteManifestSelection(manifest: ProviderModelManifest, input: { routeSlot: RouteSlot; providerKey: string; protocol: string; modelId: string; configuration?: Readonly<Record<string, unknown>> }): ModelCapability {
  const provider = manifest.providers.find(item => item.providerKey === input.providerKey);
  if (!provider) throw new ProviderGatewayError("MODEL_NOT_FOUND");
  const family = routeSlotCapabilities[input.routeSlot];
  const expectedProtocol = provider.capabilityProtocols?.[family] ?? provider.protocol;
  if (input.protocol !== expectedProtocol) throw new ProviderGatewayError("CAPABILITY_MISMATCH", "Provider protocol is not compatible with route capability");
  const catalogModel = provider.models.find(item => item.modelId === input.modelId);
  // Custom OpenAI-compatible endpoints accept a user-provided model id, while retaining the catalog's declared capability limits.
  const model: ModelCapability | undefined = catalogModel ?? (provider.providerKey === "openai-compatible" && input.modelId.trim() && provider.models[0] ? { ...provider.models[0], modelId: input.modelId } as ModelCapability : undefined);
  if (!model || !model.families.includes(family)) throw new ProviderGatewayError("CAPABILITY_MISMATCH", "Model is not compatible with route capability");
  if (input.routeSlot === "TEACH_BACK_ASSESSMENT" && model.structuredOutput !== "STRICT_JSON_SCHEMA") throw new ProviderGatewayError("CAPABILITY_MISMATCH", "Teach Back requires strict JSON schema support");
  if (family === "TEXT_GENERATION" && input.routeSlot.startsWith("BOOK_") && (model.structuredOutput === "UNSUPPORTED" || !model.structuredOutput)) throw new ProviderGatewayError("CAPABILITY_MISMATCH", "This route requires structured output support");
  if (family === "SPEECH") {
    const outputFormat = input.configuration?.outputFormat;
    if (typeof outputFormat === "string" && model.speechFormats && !model.speechFormats.includes(outputFormat)) throw new ProviderGatewayError("CAPABILITY_MISMATCH", "Speech format is unsupported by model");
  }
  return model;
}
