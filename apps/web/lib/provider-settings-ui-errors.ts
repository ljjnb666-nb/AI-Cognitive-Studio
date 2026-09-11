export const providerErrorMessages: Record<string, string> = {
  PROVIDER_SETTINGS_LOAD_FAILED: "加载 Provider 设置失败，请刷新后重试。",
  PROVIDER_SETTINGS_SAVE_FAILED: "保存 Provider 设置失败，请检查输入后重试。",
  PROVIDER_GATEWAY_MODEL_MANIFEST_MISSING: "服务目录暂不可用，请联系部署管理员。",
  PROVIDER_GATEWAY_MODEL_MANIFEST_INVALID: "服务目录配置无效，请联系部署管理员。",
  PROVIDER_GATEWAY_KEYRING_MISSING: "凭据保护服务未配置，暂时无法保存 API Key。",
  PROVIDER_CONNECTION_ENDPOINT_INVALID: "请输入有效的 HTTPS API Endpoint。",
  PROVIDER_CONNECTION_NAME_CONFLICT: "已存在同名 Provider，请换一个名称。",
  AUTHORIZATION_FAILED: "当前账户无权修改此工作区的 Provider。",
  PROVIDER_CONNECTION_PROTOCOL_INVALID: "请选择当前 Provider 支持的协议。",
  PROVIDER_CONFIGURATION_SECRET_FORBIDDEN: "高级配置不能包含密钥或凭据。",
  CAPABILITY_MISMATCH: "所选模型不支持该用途；Teach Back 需要支持严格 JSON 输出的模型。",
  TEST_CONNECTION_FAILED: "连接测试未通过。请检查 API Key、地址和网络后重试。",
};

export function readableProviderError(code: string): string {
  return providerErrorMessages[code] ?? "操作未完成，请检查输入后重试。";
}
