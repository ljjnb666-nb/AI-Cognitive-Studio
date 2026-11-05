import { PageHeader } from "@/components/app-shell";
import { ProviderSettings } from "@/components/provider-settings";
import { SettingsNavigation } from "@/components/settings-navigation";
import { ResourceBudgetSettings } from "@/components/resource-budget-settings";

export default function ProviderSettingsPage() {
  return (
    <div>
      <PageHeader
        title="Provider 设置"
        description="为当前工作区配置自带 API 密钥和执行路由。密钥仅在提交时加密保存。"
      />
      <h2 className="sr-only">AI Providers</h2>
      <SettingsNavigation active="providers" />
      <ProviderSettings />
      <ResourceBudgetSettings />
    </div>
  );
}
