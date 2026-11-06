import { PageHeader } from "@/components/app-shell";
import { ProviderSettings } from "@/components/provider-settings";
import { SettingsNavigation } from "@/components/settings-navigation";
import styles from "@/components/provider-settings.module.css";
import { ResourceBudgetSettings } from "@/components/resource-budget-settings";

export default function ProviderSettingsPage() {
  return (
    <div className={styles.page}>
      <PageHeader
        title="AI 服务商设置"
        description="先保存服务商的 API Key，再为书籍理解、思考和播客等用途选择模型。"
      />
      <h2 className="sr-only">服务商配置</h2>
      <SettingsNavigation active="providers" />
      <ProviderSettings />
      <ResourceBudgetSettings />
    </div>
  );
}
