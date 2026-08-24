import { createHash } from "node:crypto";
import { type ProviderExecutionRepository, type ProviderGateway, type SpeechResponse } from "@ai-cognitive/provider-gateway";
import type { DurableSpeechSynthesisProvider } from "./audio.js";

type Runtime = { gateway: ProviderGateway; repository: ProviderExecutionRepository; workspaceId: string; userId: string; audioGenerationRunId: string; provider: string; model: string; modelVersion?: string | null; pipelineVersion: string; speechPreparationVersion: string };
type Receipt = { invocationId: string; snapshotId: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Run-scoped PODCAST_TTS adapter.  The caller never chooses provider/model. */
export class GatewayPodcastSpeechSynthesisProvider implements DurableSpeechSynthesisProvider {
  readonly identity: { provider: string; model: string; modelVersion?: string };
  readonly capabilities = { supportsSSML: false, supportedOutputFormats: ["wav"] };
  private readonly receipts = new Map<string, Receipt>();
  constructor(private readonly runtime: Runtime) { this.identity = { provider: runtime.provider, model: runtime.model, ...(runtime.modelVersion ? { modelVersion: runtime.modelVersion } : {}) }; }
  async synthesize(input: Parameters<DurableSpeechSynthesisProvider["synthesize"]>[0]) {
    if (!input.operationKey || !input.semanticIdentity) throw new Error("AUDIO_SPEECH_OPERATION_IDENTITY_MISSING");
    const speech = { text: input.text, language: input.language, voice: input.voice, outputFormat: input.outputFormat, ssml: input.text.startsWith("<speak>") };
    const request = { workspaceId: this.runtime.workspaceId, routeSlot: "PODCAST_TTS" as const, correlationId: input.correlationId, idempotencyKey: input.operationKey, inputHash: hash({ ...input.semanticIdentity, speech }), capability: { family: "SPEECH" as const, outputFormat: input.outputFormat }, speech, pipelineVersion: `${this.runtime.pipelineVersion}:speech:${this.runtime.speechPreparationVersion}` };
    const existing = await this.runtime.repository.findExistingSpeechInvocationForRequest(request);
    if (existing) {
      const handoff = await this.runtime.repository.recoverSpeechHandoff(this.runtime.workspaceId, existing.invocationId);
      if (handoff.kind !== "RECOVERABLE") throw new Error("AUDIO_SPEECH_RECONCILIATION_REQUIRED");
      this.receipts.set(input.operationKey, { invocationId: existing.invocationId, snapshotId: existing.snapshotId });
      return handoff.response;
    }
    const snapshot = await this.runtime.gateway.resolveSnapshot(request);
    if (snapshot.providerKey !== this.runtime.provider || snapshot.modelId !== this.runtime.model || (this.runtime.modelVersion && snapshot.configuration.modelVersion !== this.runtime.modelVersion)) throw new Error("AUDIO_GATEWAY_ROUTE_IDENTITY_MISMATCH");
    const outcome = await this.runtime.gateway.execute(request, { userId: this.runtime.userId });
    if (outcome.status !== "SUCCEEDED" && outcome.status !== "ALREADY_PROCESSED") throw new Error(`AUDIO_SPEECH_GATEWAY_${outcome.status}`);
    if (!outcome.invocationId || !outcome.snapshot || outcome.status === "ALREADY_PROCESSED") throw new Error("AUDIO_SPEECH_RECONCILIATION_REQUIRED");
    const response = outcome.response as SpeechResponse | undefined;
    if (!response) throw new Error("AUDIO_SPEECH_RECONCILIATION_REQUIRED");
    this.receipts.set(input.operationKey, { invocationId: outcome.invocationId, snapshotId: outcome.snapshot.id });
    return response;
  }
  async consumeSpeechResult(input: { operationKey: string; consumerKind: string; consumerKey: string; consumerFingerprint: string }, materialize: (tx: unknown) => Promise<void>): Promise<"CONSUMED" | "ALREADY_CONSUMED"> {
    const receipt = this.receipts.get(input.operationKey); if (!receipt) throw new Error("AUDIO_SPEECH_RECONCILIATION_REQUIRED");
    const result = await this.runtime.repository.consumeSpeechResult({ workspaceId: this.runtime.workspaceId, invocationId: receipt.invocationId, snapshotId: receipt.snapshotId, consumerKind: input.consumerKind, consumerKey: input.consumerKey, consumerFingerprint: input.consumerFingerprint }, async ({ tx }) => materialize(tx));
    return result.status;
  }
  async verifyConsumedSpeechResult(input: { operationKey: string; consumerKind: string; consumerKey: string; consumerFingerprint: string }): Promise<"NOT_CONSUMED" | "EXACT" | "RECONCILIATION_REQUIRED"> {
    const invocation = await this.runtime.repository.findExistingSpeechInvocation(this.runtime.workspaceId, input.operationKey);
    if (!invocation) return "NOT_CONSUMED";
    const tombstone = await this.runtime.repository.findConsumedSpeechTombstone(this.runtime.workspaceId, invocation.invocationId);
    if (!tombstone) return "NOT_CONSUMED";
    return tombstone.consumerKind === input.consumerKind && tombstone.consumerKey === input.consumerKey && tombstone.consumerFingerprint === input.consumerFingerprint ? "EXACT" : "RECONCILIATION_REQUIRED";
  }
}
