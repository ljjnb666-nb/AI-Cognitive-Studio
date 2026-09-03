/** Product-facing copy for errors returned by Studio APIs. Keep diagnostic codes server-side. */
const providerCodes = new Set([
  "AI_PROVIDER_CONFIGURATION_REQUIRED",
  "BOOK_ROUTE_IDENTITY_INCONSISTENT",
]);

export function needsProviderConfiguration(code?: string | null) {
  return Boolean(code && providerCodes.has(code));
}

export function bookIntelligenceErrorMessage(code?: string | null) {
  switch (code) {
    case "AI_PROVIDER_CONFIGURATION_REQUIRED":
      return "需要先配置 Provider，才能继续理解这本书。";
    case "BOOK_ROUTE_IDENTITY_INCONSISTENT":
      return "当前 Provider 配置需要重新确认后才能继续。";
    case "BOOK_INTELLIGENCE_REQUEST_FAILED":
      return "暂时无法开始理解，请稍后重试。";
    default:
      return "暂时无法完成这一步，请稍后重试。";
  }
}

export function uploadErrorMessage(code?: string | null) {
  const normalized = code?.toUpperCase() ?? "";
  if (
    normalized.includes("TOO_LARGE") ||
    normalized.includes("FILE_SIZE") ||
    normalized.includes("SIZE_INVALID")
  ) {
    return "文件超过当前允许的大小。";
  }
  if (normalized.includes("UNSUPPORTED") || normalized.includes("MEDIA_TYPE")) {
    return "暂不支持这个文件格式。";
  }
  if (
    normalized.includes("UPLOAD_FAILED") ||
    normalized.includes("TRANSPORT") ||
    normalized.includes("NETWORK")
  ) {
    return "文件没有上传完成，请重新选择后再试。";
  }
  return "上传没有完成，请稍后重试。";
}

export function mediaGenerationErrorMessage(code?: string | null) {
  if (
    code === "AI_PROVIDER_CONFIGURATION_REQUIRED" ||
    code === "PODCAST_TTS_CONFIGURATION_REQUIRED"
  ) {
    return "需要先配置 Provider，才能继续生成音频。";
  }
  return "暂时无法完成音频生成，请稍后重试。";
}
