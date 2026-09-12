import { describe, expect, it } from "vitest";
import { thinkingSessionFailureForCode } from "../lib/thinking-session-errors";

describe("Phase 18.2.1 thinking-session API failures", () => {
  it.each([
    ["AI_PROVIDER_CONFIGURATION_REQUIRED", 400, "思考功能尚未配置可用的 AI Provider。"],
    ["INVALID_PROVIDER_RESPONSE", 502, "模型返回了空内容或无效响应，请重试。"],
    ["RATE_LIMITED", 429, "模型服务当前请求过多，请稍后重试。"],
    ["TIMEOUT", 504, "模型响应超时，请稍后重试。"],
    ["TRANSIENT_UPSTREAM", 503, "模型服务暂时不可用，请稍后重试。"],
    ["AUTHENTICATION_FAILED", 401, "Provider 凭证无效或已失效，请检查 Provider 设置。"],
    ["AUTHORIZATION_FAILED", 403, "Provider 没有执行该模型的权限，请检查 Provider 设置。"],
    ["MODEL_NOT_FOUND", 400, "配置的模型当前不可用，请检查 Provider 设置。"],
  ])("maps %s without upstream text", (code, status, message) => {
    expect(thinkingSessionFailureForCode(code)).toEqual({ error: code, status, message });
  });

  it("masks arbitrary errors as a retryable thinking failure", () => {
    expect(thinkingSessionFailureForCode("provider raw response")).toEqual({ error: "THINKING_SESSION_PROVIDER_FAILED", status: 502, message: "暂时无法开始思考，请稍后重试。" });
    expect(thinkingSessionFailureForCode("THINKING_SESSION_PROVIDER_FAILED")).toEqual({ error: "THINKING_SESSION_PROVIDER_FAILED", status: 502, message: "暂时无法开始思考，请稍后重试。" });
  });
});
