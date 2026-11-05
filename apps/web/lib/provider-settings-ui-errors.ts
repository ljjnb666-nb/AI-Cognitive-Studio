export const providerErrorMessages: Record<string, string> = {
  PROVIDER_CONNECTION_CHANGED: "服务商配置已变化，请刷新设置后重新确认删除。",
  CONNECTION_DISABLED: "该服务商已停用或删除，请刷新设置并检查启用状态。",
  PROVIDER_SETTINGS_INPUT_INVALID: "配置内容无效，请检查服务商或用途设置。模型请在用途配置中选择。",
  PROVIDER_MODEL_SELECTION_USE_ROUTE: "请在模型与用途配置中选择模型，服务商设置不再保存默认模型。",
  PROVIDER_SETTINGS_LOAD_FAILED: "加载 服务商 设置失败，请刷新后重试。",
  PROVIDER_SETTINGS_SAVE_FAILED: "保存 服务商 设置失败，请检查输入后重试。",
  PROVIDER_GATEWAY_MODEL_MANIFEST_MISSING: "服务目录暂不可用，请联系部署管理员。",
  PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID: "服务目录配置无效，请联系部署管理员。",
  PROVIDER_GATEWAY_KEYRING_MISSING: "凭据保护服务未配置，暂时无法保存 API Key。",
  PROVIDER_CONNECTION_ENDPOINT_INVALID: "请输入有效的 安全的接口地址。",
  PROVIDER_CONNECTION_NAME_CONFLICT: "已存在同名服务商，请换一个名称。",
  AUTHORIZATION_FAILED: "当前账户无权修改此工作区的 服务商。",
  PROVIDER_CONNECTION_PROTOCOL_INVALID: "请选择当前 服务商 支持的协议。",
  PROVIDER_CONFIGURATION_SECRET_FORBIDDEN: "高级配置不能包含密钥或凭据。",
  QWEN_CONFIGURATION_INVALID: "百炼配置无效，请检查区域、工作区 ID 和向量维度。",
  PODCAST_TTS_VOICE_UNSUPPORTED: "智谱 GLM-TTS 不支持该音色，请从音色列表中重新选择。",
  PODCAST_TTS_CONFIGURATION_REQUIRED: "请完整设置主持人音色、有效语速与 WAV 格式，再保存播客音频用途。",
  CAPABILITY_MISMATCH: "所选模型不支持该用途；理解验证 需要支持严格 JSON 输出的模型。",
  TEST_CONNECTION_FAILED: "连接测试未通过。请检查 API Key、地址和网络后重试。",
};

export function readableProviderError(code: string): string {
  return providerErrorMessages[code] ?? "操作未完成，请检查输入后重试。";
}

export function providerKeyTestMessage(state: string, providerName: string): string {
  if (state === "VALID") return "✓ API Key 身份验证通过，可保存服务商；具体模型权限以实际调用为准。";
  if (state === "AUTHENTICATION_FAILED") return "API Key 无效或无权访问此接口，请检查密钥类型及所属平台，MiniMax 还需核对国内站或国际站。";
  if (state === "TIMEOUT") return "验证超时，请稍后重试。";
  if (state === "UNSUPPORTED_TEST") return `${providerName} 暂未接入免生成的密钥验证接口；本次未验证密钥有效性，可先保存配置。`;
  if (state === "INVALID_TEST_RESPONSE") return "服务商返回了异常响应，未能确认密钥有效性，请稍后重试。";
  if (state === "PROVIDER_REJECTED") return "服务商暂未接受验证请求，请稍后重试或检查账户权限。";
  return "无法连接服务商，请检查网络后重试。";
}
