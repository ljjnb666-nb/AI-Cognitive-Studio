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
      return "需要先配置服务商，才能继续理解这本书。";
    case "BOOK_ROUTE_IDENTITY_INCONSISTENT":
      return "当前 服务商配置需要重新确认后才能继续。";
    case "BOOK_INTELLIGENCE_REQUEST_FAILED":
      return "暂时无法开始理解，请稍后重试。";
    default:
      return "暂时无法完成这一步，请稍后重试。";
  }
}

export function uploadErrorMessage(code?: string | null) {
  const normalized = code?.toUpperCase() ?? "";
  if (normalized === "UNSUPPORTED_MOBI") return "暂不支持 MOBI 格式，请先转换为 EPUB 或 PDF 后上传。";
  if (normalized === "UPLOAD_REQUEST_INVALID") return "上传信息不完整或格式无效，请重新选择文件。";
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
    return "需要先配置服务商，才能继续生成音频。";
  }
  return "暂时无法完成音频生成，请稍后重试。";
}

/** 仅呈现经过固定中文映射的错误类型，原始编号留在服务端。 */
export function processingErrorType(code?: string | null): string {
  const labels: Record<string, string> = {
    INVALID_PROVIDER_RESPONSE: "模型返回格式异常", OUTPUT_TRUNCATED: "模型输出被截断",
    ANALYSIS_PROVIDER_RESPONSE_INVALID: "理解结果结构不完整", ANALYSIS_EVIDENCE_REQUIRED: "理解结果缺少有效原文引用",
    TIMEOUT: "模型响应超时", BUDGET_EXCEEDED: "处理额度不足", CONTENT_REJECTED: "服务商内容审核拒绝",
    BOOK_ANALYSIS_EXECUTION_LEASE_EXPIRED: "任务执行凭证已过期", BOOK_ANALYSIS_EXECUTION_OWNERSHIP_LOST: "任务执行权限已失效",
    RATE_LIMITED: "服务商请求过于频繁", QUOTA_EXCEEDED: "服务商额度不足", AUTHENTICATION_FAILED: "服务商密钥验证失败",
    AUTHORIZATION_FAILED: "服务商权限不足", MODEL_NOT_FOUND: "所选模型不可用", TRANSIENT_UPSTREAM: "服务商暂时异常",
    SOURCE_PARSE_ERROR: "正文提取程序异常", SOURCE_PARSE_TIMEOUT: "正文提取超时", SOURCE_QUALITY_REJECTED: "正文提取质量未通过",
    SOURCE_CORRUPTED: "文件结构校验失败", SOURCE_OCR_REQUIRED: "文件需要文字识别", SOURCE_PASSWORD_REQUIRED: "文件需要密码",
    CANCELLED: "任务已取消", IDEMPOTENCY_CONFLICT: "任务请求与历史记录不一致",
  };
  return code && labels[code] ? labels[code] : "处理异常，具体原因待核查";
}
