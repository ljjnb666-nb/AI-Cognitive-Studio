import { z } from "zod";

const evidenceSchema = z.object({ sourceBlockId: z.string(), extractionId: z.string(), startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive() });
const schema = z.object({
  episode: z.object({ id: z.string() }),
  hosts: z.array(z.object({ id: z.string(), displayName: z.string() })),
  utterances: z.array(z.object({ id: z.string(), speakerHostId: z.string(), text: z.string(), evidence: z.array(evidenceSchema) })),
});

/** Read the published revision, never mutable utterances from a later/older run. */
export function parsePodcastScriptView(snapshot: unknown, episodeId: string) {
  const parsed = schema.safeParse(snapshot);
  if (!parsed.success || parsed.data.episode.id !== episodeId) return null;
  const hosts = new Map(parsed.data.hosts.map(host => [host.id, host.displayName]));
  if (parsed.data.utterances.some(utterance => !hosts.has(utterance.speakerHostId))) return null;
  return parsed.data.utterances.map(utterance => ({ ...utterance, speakerName: hosts.get(utterance.speakerHostId)! }));
}

export function podcastEvidenceExcerpt(evidence: z.infer<typeof evidenceSchema>, block: { extractionId: string; text: string } | undefined) {
  if (!block || block.extractionId !== evidence.extractionId || evidence.endOffset <= evidence.startOffset || evidence.endOffset > block.text.length) return null;
  return block.text.slice(evidence.startOffset, evidence.endOffset);
}
