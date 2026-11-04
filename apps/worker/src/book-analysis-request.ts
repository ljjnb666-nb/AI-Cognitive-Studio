import type { AnalysisRequest } from "@ai-cognitive/book-intelligence";
/** Remove only byte-for-byte duplicated text; retain every evidence ID and offset. */
export function bookAnalysisMessage(request: Pick<AnalysisRequest, "content" | "sourceSlices">): string {
  if (!request.sourceSlices) return request.content;
  const complete = request.sourceSlices.map(span => span.text).join("\n\n") === request.content;
  return JSON.stringify({ ...(complete ? {} : { content: request.content }), sourceSlices: request.sourceSlices });
}
