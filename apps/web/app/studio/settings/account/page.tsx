import { AccountSettings } from "@/components/account-settings";
import { PageHeader } from "@/components/app-shell";
import { resolveWebIdentity } from "@/lib/identity";

export default async function AccountSettingsPage() {
  const identity = await resolveWebIdentity();
  const workspace = identity.workspaces.find((item) => item.id === identity.workspaceId);

  return (
    <div>
      <PageHeader title="账户设置" description="管理你的个人信息、密码和当前工作区。" />
      <AccountSettings name={identity.userName || ""} email={identity.email} workspace={workspace?.name ?? ""} />
    </div>
  );
}
