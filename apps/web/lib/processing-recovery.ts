/** A small, testable boundary for recovery submission.  The UI deliberately
 * never surfaces a response body because it can contain infrastructure detail. */
export async function submitProcessingRecovery(
  sourceDocumentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<"RECOVERED" | "PROCESSING_RECOVERY_FAILED"> {
  try {
    const response = await fetchImpl(`/api/studio/processing/${sourceDocumentId}/recover`, { method: "POST" });
    return response.ok ? "RECOVERED" : "PROCESSING_RECOVERY_FAILED";
  } catch {
    return "PROCESSING_RECOVERY_FAILED";
  }
}
