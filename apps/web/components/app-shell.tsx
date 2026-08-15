import Link from "next/link";
import { prisma } from "@ai-cognitive/db";
import { resolveWebIdentity } from "@/lib/identity";
import { AccountMenu } from "./account-menu";

const links = [["/studio", "Home"], ["/studio/library", "Library"], ["/studio/podcasts", "Podcasts"], ["/studio/videos", "Videos"], ["/studio/activity", "Activity"]] as const;

export async function AppShell({ children }: { children: React.ReactNode }) {
  const identity = await resolveWebIdentity();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: identity.userId }, select: { name: true, email: true, memberships: { select: { workspaceId: true, workspace: { select: { name: true } } }, orderBy: { createdAt: "asc" } } } });
  const workspaces = user.memberships.map(({ workspaceId, workspace }) => ({ id: workspaceId, name: workspace.name }));
  const workspace = workspaces.find((item) => item.id === identity.workspaceId);
  if (!workspace) throw new Error("WORKSPACE_ACCESS_DENIED");
  return <div className="shell"><aside className="sidebar"><Link className="brand" href="/studio">AI Cognitive Studio</Link><nav aria-label="Primary navigation">{links.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}</nav><AccountMenu name={user.name || user.email} email={user.email} workspace={workspace} workspaces={workspaces} /></aside><main className="content">{children}</main><nav className="mobile-nav" aria-label="Mobile navigation">{links.map(([href, label]) => <Link key={href} href={href}>{label}</Link>)}</nav></div>;
}

export function PageHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) { return <header className="page-header"><div><p className="eyebrow">AI COGNITIVE STUDIO</p><h1>{title}</h1>{description && <p className="muted">{description}</p>}</div>{action}</header>; }
export function Status({ value }: { value: string }) { return <span className="status"><i aria-hidden="true" />{value}</span>; }
