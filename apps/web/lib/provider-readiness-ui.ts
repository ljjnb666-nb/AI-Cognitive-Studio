export type ProviderReadinessDependencyView = { label: string; state: "READY" | "MISSING"; providerName?: string; modelId?: string; error?: string; detail?: string };
export type ProviderReadinessView = { state: string; missing: readonly string[]; configured?: number; required?: number; dependencies?: readonly ProviderReadinessDependencyView[] };

export function readinessDisplay(item: ProviderReadinessView) {
  const dependencies = item.dependencies ?? [];
  const rows = dependencies.map(dependency => ({
    label: dependency.label,
    configured: dependency.state === "READY",
    detail: dependency.state === "READY"
      ? dependency.detail ?? `${dependency.providerName ?? "服务商"} · ${dependency.modelId ?? ""}`.trim()
      : dependency.error === "BOOK_EMBEDDING_PROVIDER_NOT_CONFIGURED"
        ? "尚未配置｜请选择兼容的向量模型与维度"
        : dependency.error === "PODCAST_TTS_CONFIGURATION_REQUIRED" ? "待配置｜请设置主持人音色、语速与 WAV 格式"
        : dependency.error === "PODCAST_TTS_ROUTE_REQUIRED" ? "请先绑定语音模型" : "尚未配置",
  }));
  return {
    summary: item.required !== undefined && item.configured !== undefined ? `${item.configured} / ${item.required} 已配置` : undefined,
    rows,
    completion: item.state === "READY" ? "已就绪" : item.required !== undefined && item.configured !== undefined ? `待完成 ${item.required - item.configured} 项` : undefined,
  };
}
