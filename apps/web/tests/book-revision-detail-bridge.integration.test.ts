import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import SourcePage from "../app/studio/library/[sourceDocumentId]/page";
import { sourceDetail } from "../lib/product";

vi.mock("../lib/product", () => ({ sourceDetail: vi.fn() }));
vi.mock("../lib/worker-heartbeat", () => ({ processingWorkerAvailability: vi.fn().mockResolvedValue("UNKNOWN") }));
vi.mock("../components/book-detail-view", () => ({ BookDetailView: () => null }));
vi.mock("../components/cancel-job-button", () => ({ CancelJobButton: () => null }));

describe("published revision -> book detail page presentation bridge", () => {
  it("passes the published summary and revised evidence-backed memory, not original analysis rows", async () => {
    const original = { id: "original", type: "CLAIM", content: "UNREVIEWED ORIGINAL MEMORY", ordinal: 0, evidence: [] };
    const revised = { id: "original", type: "CLAIM", content: "VERIFIED REVISION MEMORY", ordinal: 0, evidence: [] };
    vi.mocked(sourceDetail).mockResolvedValueOnce({
      id: "source-document", version: 1, mediaType: "text/markdown",
      source: { displayName: "book.md", edition: null, documents: [{ id: "source-document" }] },
      ingestionRuns: [], analysisRuns: [], bookAnalysisBootstraps: [],
      currentIntelligence: { analysisRun: { memoryItems: [original] } },
      currentExtraction: null, structureNodes: [], textPreview: null,
      bookMemories: [revised], bookSummary: "VERIFIED REVISION SUMMARY", analysisProgress: null,
    } as never);
    const page = await SourcePage({
      params: Promise.resolve({ sourceDocumentId: "source-document" }),
      searchParams: Promise.resolve({}),
    });
    const directChildren = Children.toArray((page.props as { children: ReactNode }).children);
    const view = directChildren.find(node => isValidElement(node) && "memories" in (node.props as Record<string, unknown>));
    expect(view).toBeDefined();
    const props = (view as { props: { memories: unknown; bookSummary: unknown } }).props;
    expect(props.memories).toEqual([revised]);
    expect(props.memories).not.toEqual([original]);
    expect(props.bookSummary).toBe("VERIFIED REVISION SUMMARY");
  });
});
