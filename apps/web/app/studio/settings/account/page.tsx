import { prisma } from "@ai-cognitive/db";
import { AccountSettings } from "@/components/account-settings";
import { PageHeader } from "@/components/app-shell";
import { resolveWebIdentity } from "@/lib/identity";

export default async function AccountSettingsPage() { const identity = await resolveWebIdentity(); const [user, workspace] = await Promise.all([prisma.user.findUniqueOrThrow({ where: { id: identity.userId }, select: { name: true, email: true } }), prisma.workspace.findUniqueOrThrow({ where: { id: identity.workspaceId }, select: { name: true } })]); return <><PageHeader title="账户设置" description="管理你的个人信息、密码和当前工作区。" /><AccountSettings name={user.name || ""} email={user.email} workspace={workspace.name} /></>; }
