# Provider 设置（Closed Beta）

## 给使用者

进入“设置 → Provider”，选择 AI 服务，填入 API Key，按需修改 Base URL，点击“测试连接”，再点击“保存 Provider”。随后在“配置用途”中为书籍理解、播客脚本、语音合成、短视频、思考、Teach Back 和向量检索选择兼容模型。普通使用者不需要编辑 `.env`，也不需要了解凭据加密密钥。

## 给部署者

生产环境必须通过 `PROVIDER_GATEWAY_KEYRING` 提供可轮换的 AES-256-GCM keyring；缺失时保存操作会失败关闭。开发环境首次保存 BYOK 凭据时会在 `.runtime/secrets/provider-gateway-keyring.json` 生成本地 keyring。该文件不会提交；若删除，原有本地凭据将无法解密。

内置目录包含 OpenAI、Anthropic、Google Gemini、DeepSeek、智谱 GLM 与 OpenAI 兼容服务。`PROVIDER_GATEWAY_MODEL_MANIFEST` 是可选的部署者扩展/覆盖目录，不是 Provider 页面加载的前提。若其覆盖同名内置服务，部署者定义优先。
