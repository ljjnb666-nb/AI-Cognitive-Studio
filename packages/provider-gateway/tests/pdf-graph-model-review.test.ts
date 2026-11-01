import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { stableHash } from "../src/routing/snapshot.js";
import { createGatewayPdfGraphModelReviewer, PDF_GRAPH_REVIEW_AXES,
  validatePdfGraphModelReview } from "../src/vision/pdf-graph-model-review.js";
import type { ProviderGateway } from "../src/runtime/gateway.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const hash = (value:Uint8Array|string) => createHash("sha256").update(value).digest("hex");
const sourceSha = "a".repeat(64);
const candidateJson = { schemaVersion: 1, figures: [{
  id: "fig",kind: "DIAGRAM",bbox: [10,20,200,300],caption: "test",
  nodes: [{ id: "left", label: "A" }, { id: "right", label: "B" }],
  edges: [{from: "left",to: "right",label: "arrow",direction: "DIRECTED"}],
}] };
const baseInput = () => ({
  physicalPageIndex: 0, sourceSha256: sourceSha, pngSha256: hash(png),
  pngBytes: new Uint8Array(png), width: 1, height: 1,
  candidateJson, candidateSha256: stableHash(candidateJson),
  sourceTextExcerpt: "Source text A -> B",
  sourceTextPreviewTruncated: false,
  explicitSecondCallConsent: true as const,
});
const identity = () => ({
  sourceSha256: sourceSha, sourcePngSha256: hash(png),
  physicalPageIndex: 0, candidateSha256: stableHash(candidateJson),
  textSha256: hash("Source text A -> B"),
});
const response = (changes: Record<string,unknown> = {}) => ({
  schemaVersion: 1, ...identity(),
  axes: Object.fromEntries(PDF_GRAPH_REVIEW_AXES.map(axis =>
    [axis, { status: "CLEAR", reason: "Visible original page supports the candidate." }])),
  ...changes,
});
function fake(reply: unknown = response()) {
  const execute = vi.fn(async () => ({
    status: "SUCCEEDED" as const,
    response: { type: "STRUCTURED", structured: reply, finishReason: "STOP" },
    invocationId: "paid-invocation", snapshot: {
      id: "signed-snapshot", providerKey: "zhipu", modelId: "glm-4.6v",
    },
    usage: { inputTokens: 200, outputTokens: 120 },
  }));
  const reviewer = createGatewayPdfGraphModelReviewer({
    gateway: { execute } as unknown as ProviderGateway,
    workspaceId: "w", userId: "u", sourceDocumentId: "d", ingestionRunId: "run",
    reviewRequestId: "modelreview01", enabled: true,
  });
  return { execute, reviewer };
}

describe("explicit second-pass graph model verification via provider Gateway", () => {
  it("requires a second consent and source-matched image/graph BEFORE provider admission", async () => {
    const f = fake();
    for (const input of [
      {...baseInput(), explicitSecondCallConsent: false as true},
      {...baseInput(), sourceSha256: "wrong"},
      {...baseInput(), pngSha256: "0".repeat(64)},
      {...baseInput(), candidateSha256: "0".repeat(64)},
      {...baseInput(), sourceTextExcerpt: ""},
      {...baseInput(), width: 40000},
    ]) await expect(f.reviewer.review(input)).rejects.toThrow();
    expect(f.execute).toHaveBeenCalledTimes(0);
  });
  it("submits original pixels, source text and graph to a separate idempotent one-attempt paid action", async () => {
    const f = fake();
    const result = await f.reviewer.review(baseInput());
    expect(result).toMatchObject({
      decision: { status: "PASSED", approvedForPodcast: false, approvedForBookIntelligence: false },
      invocationId: "paid-invocation", snapshotId: "signed-snapshot",
      providerKey: "zhipu", approvedForPodcast: false, approvedForBookIntelligence: false,
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
    const [request, principal] = f.execute.mock.calls[0] as unknown as [Record<string,unknown>, {userId:string}];
    expect(principal).toEqual({userId:"u"});
    expect(request.routeSlot).toBe("PDF_VISUAL_STRUCTURE");
    expect(request.capability).toEqual({
      family: "TEXT_GENERATION", visionInput: true, structuredOutput: "JSON_MODE",
    });
    expect(request.budget).toMatchObject({ maxAttempts: 1, maxImageBytes: 8000000 });
    expect(String(request.idempotencyKey)).toContain("pdf-graph-second-review-v1");
    const user = (request.text as {messages:Array<{content:string;image:{sourceSha256:string}}>} ).messages[0]!;
    expect(user.content).toContain(stableHash(candidateJson));
    expect(user.image.sourceSha256).toBe(sourceSha);
    expect(user.content).toContain("Source text A -> B");
  });
  it("rejects altered identity, missing axes and self-declared podcast approval", () => {
    expect(() => validatePdfGraphModelReview(response({sourceSha256: "0".repeat(64)}),identity(),false)).toThrow();
    expect(() => validatePdfGraphModelReview(response({approvedForPodcast: true}),identity(),false)).toThrow();
    const missing = response();
    delete (missing.axes as Record<string,unknown>).relationships;
    expect(() => validatePdfGraphModelReview(missing,identity(),false)).toThrow();
  });
  it("treats unknowns and source-text truncation as REVIEW_REQUIRED, never automatic publish", async () => {
    const unknown = response();
    (unknown.axes as Record<string,{status:string;reason:string}>).figureCoverage!.status = "UNKNOWN";
    expect(validatePdfGraphModelReview(unknown,identity(),false).status).toBe("REVIEW_REQUIRED");
    const f = fake(response());
    const decision = await f.reviewer.review({...baseInput(),sourceTextPreviewTruncated:true});
    expect(decision.decision.status).toBe("REVIEW_REQUIRED");
    expect(decision.approvedForPodcast).toBe(false);
    const long = fake(response({textSha256:hash("x".repeat(1500))}));
    const clipped = await long.reviewer.review({...baseInput(),sourceTextExcerpt:"x".repeat(2000)});
    expect(clipped.decision.status).toBe("REVIEW_REQUIRED");
  });
  it("rejects explicit visual mismatches rather than silently accepting a graph", () => {
    const bad = response();
    (bad.axes as Record<string,{status:string;reason:string}>).relationships!.status = "ISSUE";
    expect(validatePdfGraphModelReview(bad,identity(),false).status).toBe("REJECTED");
  });
  it("fails on unstructured or malformed provider output without a published result", async () => {
    const f = fake({schemaVersion:1,wrong:true});
    await expect(f.reviewer.review(baseInput())).rejects.toThrow();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
