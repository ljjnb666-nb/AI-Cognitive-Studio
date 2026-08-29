import { PageHeader } from "@/components/app-shell";
import { ProviderSettings } from "@/components/provider-settings";

export default function ProviderSettingsPage() {
  return (
    <div>
      <PageHeader
        title="AI Providers"
        description="为当前工作区配置自带 API 密钥和执行路由。密钥仅在提交时加密保存。"
      />
      <ProviderSettings />
    </div>
  );
}
