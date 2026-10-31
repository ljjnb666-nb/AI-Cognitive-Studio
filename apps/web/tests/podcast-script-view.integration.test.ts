import { expect, it } from "vitest";
import { parsePodcastScriptView, podcastEvidenceExcerpt } from "../lib/podcast-script-view";

it("shows only the pinned revision text and host names, with no generation-run fallback", () => {
  const snapshot = { episode: { id: "episode" }, hosts: [{ id: "host", displayName: "主持人" }], utterances: [{ id: "u", speakerHostId: "host", text: "独立校订后的文稿", evidence: [] }] };
  expect(parsePodcastScriptView(snapshot, "episode")?.[0]).toMatchObject({ text: "独立校订后的文稿", speakerName: "主持人" });
  expect(parsePodcastScriptView(snapshot, "another-episode")).toBeNull();
  expect(parsePodcastScriptView({ ...snapshot, hosts: [] }, "episode")).toBeNull();
  expect(parsePodcastScriptView({}, "episode")).toBeNull();
});
it("displays only the exact stored evidence range in its extraction", () => {
  const evidence = { sourceBlockId: "block", extractionId: "extraction", startOffset: 1, endOffset: 3 };
  expect(podcastEvidenceExcerpt(evidence, { extractionId: "extraction", text: "甲乙丙丁" })).toBe("乙丙");
  expect(podcastEvidenceExcerpt(evidence, { extractionId: "foreign", text: "甲乙丙丁" })).toBeNull();
  expect(podcastEvidenceExcerpt({ ...evidence, endOffset: 8 }, { extractionId: "extraction", text: "甲乙丙丁" })).toBeNull();
  expect(podcastEvidenceExcerpt(evidence, undefined)).toBeNull();
});
