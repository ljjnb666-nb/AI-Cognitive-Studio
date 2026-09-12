const failures: Record<string, { message: string; status: number }> = {
  AI_PROVIDER_CONFIGURATION_REQUIRED: { message: "思考功能尚未配置可用的 AI Provider。", status: 400 },
  INVALID_PROVIDER_RESPONSE: { message: "模型返回了空内容或无效响应，请重试。", status: 502 },
  RATE_LIMITED: { message: "模型服务当前请求过多，请稍后重试。", status: 429 },
  TIMEOUT: { message: "模型响应超时，请稍后重试。", status: 504 },
  TRANSIENT_UPSTREAM: { message: "模型服务暂时不可用，请稍后重试。", status: 503 },
  AUTHENTICATION_FAILED: { message: "Provider 凭证无效或已失效，请检查 Provider 设置。", status: 401 },
  AUTHORIZATION_FAILED: { message: "Provider 没有执行该模型的权限，请检查 Provider 设置。", status: 403 },
  MODEL_NOT_FOUND: { message: "配置的模型当前不可用，请检查 Provider 设置。", status: 400 },
  THINKING_SESSION_PROVIDER_FAILED: { message: "暂时无法开始思考，请稍后重试。", status: 502 },
};

export function thinkingSessionFailureForCode(raw: string | undefined) {
  if (raw === "COGNITION_NOT_CURRENT") return { error: raw, message: "该认知已不是当前版本，请返回认知详情后重试。", status: 404 };
  if (raw === "WEB_IDENTITY_REQUIRED") return { error: raw, message: "请先登录后再开始思考。", status: 401 };
  const failure = raw ? failures[raw] : undefined;
  return { error: failure ? raw! : "THINKING_SESSION_PROVIDER_FAILED", message: failure?.message ?? failures.THINKING_SESSION_PROVIDER_FAILED.message, status: failure?.status ?? failures.THINKING_SESSION_PROVIDER_FAILED.status };
}
