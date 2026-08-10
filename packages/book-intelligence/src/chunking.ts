import { createHash } from "node:crypto";

export const CHUNKING_VERSION = "structure-aware-v1";
export type BlockKind = "HEADING" | "PARAGRAPH" | "LIST_ITEM" | "QUOTE" | "TABLE" | "IMAGE" | "CAPTION" | "FOOTNOTE" | "CODE" | "EQUATION" | "UNKNOWN";
export interface SourceBlockInput { id: string; ordinal: number; text: string; kind: BlockKind; pageOrdinal?: number | null; metadata?: { headingLevel?: unknown } }
export interface Provenance { sourceBlockId: string; ordinal: number; startOffset: number; endOffset: number }
export interface StructureNode { ordinal: number; kind: "ROOT" | "CHAPTER" | "SECTION" | "SUBSECTION" | "STRUCTURAL_GROUP" | "PAGE_GROUP"; effectiveDepth: number; title?: string; startBlockOrdinal: number; endBlockOrdinal: number; parentOrdinal?: number }
export interface BuiltChunk { ordinal: number; content: string; contentHash: string; characterCount: number; tokenEstimate: number; sourceSpans: Provenance[]; structureOrdinal?: number }
export interface ChunkingOptions { targetSize: number; hardMax: number }

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export function isSafeBoundary(text: string, offset: number): boolean { return offset <= 0 || offset >= text.length || !(/[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!)); }
export function validateEvidence(block: Pick<SourceBlockInput, "text">, span: Pick<Provenance, "startOffset" | "endOffset">, quote?: string): boolean {
  return Number.isInteger(span.startOffset) && Number.isInteger(span.endOffset) && span.startOffset >= 0 && span.endOffset > span.startOffset && span.endOffset <= block.text.length && isSafeBoundary(block.text, span.startOffset) && isSafeBoundary(block.text, span.endOffset) && (quote === undefined || block.text.slice(span.startOffset, span.endOffset) === quote);
}

export function buildStructure(blocks: SourceBlockInput[]): StructureNode[] {
  const ordered = [...blocks].sort((a, b) => a.ordinal - b.ordinal); if (!ordered.length) return [];
  const nodes: StructureNode[] = [{ ordinal: 0, kind: "ROOT", effectiveDepth: 0, startBlockOrdinal: ordered[0]!.ordinal, endBlockOrdinal: ordered.at(-1)!.ordinal }];
  const stack: StructureNode[] = [nodes[0]!]; let next = 1;
  for (const block of ordered) {
    if (block.kind !== "HEADING") continue;
    const match = block.text.match(/^(#{1,6})\s+(.+?)\s*$/); const metadataLevel = block.metadata?.headingLevel; const markdownDepth = match?.[1]?.length;
    const effectiveDepth = typeof metadataLevel === "number" && Number.isInteger(metadataLevel) && metadataLevel >= 1 && metadataLevel <= 6 ? metadataLevel : markdownDepth ?? 2;
    const kind = effectiveDepth === 1 ? "CHAPTER" : effectiveDepth === 2 ? "SECTION" : "SUBSECTION";
    while (stack.length > 1 && stack.at(-1)!.effectiveDepth >= effectiveDepth) stack.pop()!.endBlockOrdinal = block.ordinal - 1;
    const node: StructureNode = { ordinal: next++, kind, effectiveDepth, title: match?.[2] ?? block.text.trim(), startBlockOrdinal: block.ordinal, endBlockOrdinal: ordered.at(-1)!.ordinal, parentOrdinal: stack.at(-1)!.ordinal }; nodes.push(node); stack.push(node);
  }
  if (nodes.length === 1) nodes.push({ ordinal: 1, kind: ordered.some((b) => b.pageOrdinal != null) ? "PAGE_GROUP" : "STRUCTURAL_GROUP", effectiveDepth: 1, startBlockOrdinal: ordered[0]!.ordinal, endBlockOrdinal: ordered.at(-1)!.ordinal, parentOrdinal: 0 });
  return nodes;
}

function splitSafe(text: string, max: number): Array<{ start: number; end: number }> { const result = []; for (let start = 0; start < text.length;) { let end = Math.min(start + max, text.length); if (end < text.length) { const window = text.slice(start, end); const point = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("。"), window.lastIndexOf("\n")); if (point > max * 0.45) end = start + point + (window.startsWith("\n", point) ? 2 : 1); while (!isSafeBoundary(text, end)) end--; } result.push({ start, end }); start = end; } return result; }
export function chunkBlocks(blocks: SourceBlockInput[], options: ChunkingOptions): BuiltChunk[] {
  if (!Number.isInteger(options.targetSize) || options.targetSize < 2 || !Number.isInteger(options.hardMax) || options.hardMax < options.targetSize) throw new Error("INVALID_CHUNK_LIMITS");
  const units = [...blocks].sort((a,b)=>a.ordinal-b.ordinal).flatMap((block) => splitSafe(block.text, options.hardMax).map(({start,end}) => ({ block, start, end, text: block.text.slice(start,end) })));
  const chunks: BuiltChunk[] = []; let pending: typeof units = []; let size = 0;
  const flush = () => { if (!pending.length) return; const content = pending.map((p)=>p.text).join("\n\n"); const ordinal = chunks.length; chunks.push({ ordinal, content, contentHash: sha256(content), characterCount: content.length, tokenEstimate: Math.ceil(content.length / 4), sourceSpans: pending.map((p, i)=>({ sourceBlockId:p.block.id, ordinal:i, startOffset:p.start, endOffset:p.end })) }); pending=[]; size=0; };
  for (const unit of units) { const separatorCost = pending.length ? 2 : 0; if (pending.length && (unit.block.kind === "HEADING" || size + separatorCost + unit.text.length > options.targetSize || size + separatorCost + unit.text.length > options.hardMax)) flush(); pending.push(unit); size += (pending.length === 1 ? 0 : 2) + unit.text.length; if (size >= options.hardMax) flush(); } flush();
  if (chunks.some((chunk)=>!chunk.content || chunk.characterCount > options.hardMax)) throw new Error("CHUNKING_INVARIANT_FAILED"); return chunks;
}
