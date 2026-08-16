export const routeSlots = ["BOOK_CHUNK_ANALYSIS", "BOOK_REDUCTION_ANALYSIS", "BOOK_SYNTHESIS", "EMBEDDING", "PODCAST_SCRIPT", "PODCAST_TTS", "SHORT_VIDEO_SCRIPT", "SHORT_VIDEO_TTS"] as const;
export type RouteSlot = (typeof routeSlots)[number];
export type CapabilityFamily = "TEXT_GENERATION" | "EMBEDDING" | "SPEECH";
export type ProtocolFamily = "OPENAI_RESPONSES" | "OPENAI_COMPATIBLE" | "ANTHROPIC_COMPATIBLE" | "GEMINI_NATIVE" | "CUSTOM_SPEECH" | "TEST";
export type CapabilityConfidence = "VERIFIED" | "DECLARED" | "EXPERIMENTAL";
export type StructuredOutputMode = "STRICT_JSON_SCHEMA" | "JSON_MODE" | "PROMPT_ONLY" | "UNSUPPORTED";

export type ModelCapability = {
  modelId: string;
  families: readonly CapabilityFamily[];
  confidence: CapabilityConfidence;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  structuredOutput?: StructuredOutputMode;
  streaming?: boolean;
  embeddingDimensions?: number;
  configurableEmbeddingDimensions?: boolean;
  speechFormats?: readonly string[];
  languages?: readonly string[];
};

export type ProviderDefinition = { providerKey: string; displayName: string; protocol: ProtocolFamily; adapterVersion: string; models: readonly ModelCapability[] };
export type CapabilityRequest = { family: CapabilityFamily; structuredOutput?: StructuredOutputMode; minimumInputTokens?: number; minimumOutputTokens?: number; outputFormat?: string };
export type UntrustedDataPolicy = { toolsEnabled: false; webBrowsingEnabled: false; externalActionsEnabled: false };
export const sourceDataPolicy: UntrustedDataPolicy = { toolsEnabled: false, webBrowsingEnabled: false, externalActionsEnabled: false };
export type JsonSchema = Readonly<Record<string, unknown>>;
export type TextMessage = { role: "user" | "assistant"; content: string };
export type TextGenerationInput = { system?: string; messages: readonly TextMessage[]; generation?: { maxOutputTokens?: number; temperature?: number; topP?: number }; structuredOutput?: { mode: Exclude<StructuredOutputMode, "UNSUPPORTED">; schemaName?: string; schema?: JsonSchema } };
export type TextGenerationResponse = { type: "TEXT" | "STRUCTURED"; text?: string; structured?: unknown; finishReason?: "STOP" | "LENGTH" | "CONTENT_FILTER" | "OTHER"; providerModel?: string };
export type GatewayRequest = { workspaceId: string; routeSlot: RouteSlot; correlationId: string; idempotencyKey: string; inputHash: string; capability: CapabilityRequest; text?: TextGenerationInput; budget?: ResourceBudget; estimates?: ResourceEstimates; signal?: AbortSignal; promptVersion?: string; schemaVersion?: string; pipelineVersion?: string; untrustedDataPolicy?: UntrustedDataPolicy };
export type ResourceBudget = { maxInputTokens?: number; maxOutputTokens?: number; maxEmbeddingInputTokens?: number; maxSpeechCharacters?: number; maxAttempts?: number };
export type ResourceEstimates = { inputTokens?: number; outputTokens?: number; embeddingInputTokens?: number; speechCharacters?: number };
export type ResolvedRoute = { source: "WORKSPACE" | "PLATFORM"; providerKey: string; protocol: ProtocolFamily; modelId: string; adapterVersion: string; connectionId?: string; credentialVersionId?: string; endpoint?: string; region?: string; capability: ModelCapability; configuration: Readonly<Record<string, unknown>> };
export type ExecutionSnapshot = ResolvedRoute & { id: string; workspaceId: string; routeSlot: RouteSlot; configurationHash: string; correlationId: string; promptVersion?: string; schemaVersion?: string; pipelineVersion?: string; createdAt: Date };
export type PlatformDefaultResolver = { resolve(input: Pick<GatewayRequest, "workspaceId" | "routeSlot" | "capability">): Promise<ResolvedRoute | undefined> };
export type AdapterRequest = GatewayRequest & { requestFingerprint: string };
export type ProviderAdapter = { execute(input: { snapshot: ExecutionSnapshot; request: AdapterRequest; signal: AbortSignal; credential?: string }): Promise<{ usage?: ProviderUsage; remoteRequestId?: string; response?: unknown }> };
export type ProviderUsage = { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; embeddingInputTokens?: number; speechInputCharacters?: number; audioDurationMs?: number; latencyMs?: number; extra?: Record<string, unknown> };
export type ExecutionPrincipal = { userId: string };
