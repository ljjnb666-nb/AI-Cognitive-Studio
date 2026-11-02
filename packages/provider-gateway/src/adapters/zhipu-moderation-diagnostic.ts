/** Allowlisted metadata only. Never retain provider messages, labels or source text. */
export function zhipuModerationDiagnostic(value: unknown, httpStatus: number) {
  const body = value as { error?: { code?: unknown }; content_filter?: unknown; contentFilter?: unknown; choices?: Array<{ finish_reason?: unknown }> } | null;
  const entries = body?.content_filter ?? body?.contentFilter;
  const filters = (Array.isArray(entries) ? entries.slice(0, 16) : []).map(value => {
    const item = value as { role?: unknown; level?: unknown } | null;
    const role = item?.role === "user" || item?.role === "assistant" || item?.role === "system" ? item.role : "UNKNOWN";
    const level = typeof item?.level === "number" && Number.isInteger(item.level) && item.level >= 0 && item.level <= 10 ? item.level : "UNKNOWN";
    return { role, level };
  });
  const reason = body?.choices?.[0]?.finish_reason;
  return { httpStatus, businessCode: String(body?.error?.code) === "1301" ? "1301" : "UNKNOWN", finishReason: reason === "sensitive" || reason === "content_filter" ? reason : "UNKNOWN", filters: filters.length ? filters : [{ role: "UNKNOWN", level: "UNKNOWN" }] };
}
