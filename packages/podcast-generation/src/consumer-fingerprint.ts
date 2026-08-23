import { createHash } from "node:crypto";

/** Stable JSON encoding for persisted consumer identity. Object keys are sorted; array order is semantic. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function podcastConsumerFingerprint(input: {
  run: { workspaceId: string; id: string; generationIdentityHash: string; sources: Array<{ sourceDocumentId: string; extractionId: string; chunkSetId: string; analysisRunId: string }>; styleProfileId: string; styleProfileVersion: string; hostConfigurationVersion: string; pipelineVersion: string; promptVersion: string };
  stage: string;
  destination: string;
  input: unknown;
  output: unknown;
}): string {
  const { run, stage, destination, input: stageInput, output } = input;
  return createHash("sha256").update(canonicalJson({ workspaceId: run.workspaceId, runId: run.id, stage, destination, generationIdentityHash: run.generationIdentityHash, sources: run.sources.map((source) => [source.sourceDocumentId, source.extractionId, source.chunkSetId, source.analysisRunId]), styleProfileId: run.styleProfileId, styleProfileVersion: run.styleProfileVersion, hostConfigurationVersion: run.hostConfigurationVersion, pipelineVersion: run.pipelineVersion, promptVersion: run.promptVersion, input: normalizeInput(stageInput), output })).digest("hex");
}

/** Retrieval and provider output ordering have different semantics: normalize only set-like request fields. */
function normalizeInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeInput);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(Object.entries(record).map(([key, child]) => [key, normalizeInput(child)]));
  for (const key of ["context", "hosts", "availableMemoryIds"]) {
    if (Array.isArray(normalized[key])) normalized[key] = [...normalized[key] as unknown[]].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  }
  return normalized;
}
