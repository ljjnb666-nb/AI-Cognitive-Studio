import type { AnalysisRequest } from "@ai-cognitive/book-intelligence";
/** Remove only byte-for-byte duplicated text; retain every evidence ID and offset. */
export function bookAnalysisMessage(request: Pick<AnalysisRequest, "content" | "sourceEvidence">): string {
  if (!request.sourceEvidence) return request.content;
  const complete = request.sourceEvidence.map(span => span.text).join("\n\n") === request.content;
  return JSON.stringify({ ...(complete ? {} : { content: request.content }), sourceEvidence: request.sourceEvidence });
}
