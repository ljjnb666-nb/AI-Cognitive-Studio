export type ProviderReadinessDependencyView = { label: string; state: "READY" | "MISSING"; providerName?: string; modelId?: string; error?: string };
export type ProviderReadinessView = { state: string; missing: readonly string[]; configured?: number; required?: number; dependencies?: readonly ProviderReadinessDependencyView[] };

export function readinessDisplay(item: ProviderReadinessView) {
  const dependencies = item.dependencies ?? [];
  const rows = dependencies.map(dependency => ({
    label: dependency.label,
    configured: dependency.state === "READY",
    detail: dependency.state === "READY"
      ? `${dependency.providerName ?? "Provider"} · ${dependency.modelId ?? ""}`.trim()
      : dependency.error === "BOOK_EMBEDDING_PROVIDER_NOT_CONFIGURED"
        ? "尚未配置｜推荐：Gemini Embedding 2 · 768维"
        : "尚未配置",
  }));
  return {
    summary: item.required !== undefined && item.configured !== undefined ? `${item.configured} / ${item.required} 已配置` : undefined,
    rows,
    completion: item.state === "READY" ? "已就绪" : item.required !== undefined && item.configured !== undefined ? `待完成 ${item.required - item.configured} 项` : undefined,
  };
}
