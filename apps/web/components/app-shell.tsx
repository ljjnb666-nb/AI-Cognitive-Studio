import Link from "next/link";
import { resolveWebIdentity } from "@/lib/identity";
import { AccountMenu } from "./account-menu";
import { StudioNavigation } from "./studio-navigation";

import { PageHeader } from "./page-header";
import { BetaSessionTracker } from "./beta-session-tracker";
import { BetaFeedbackButton } from "./beta-feedback-button";
import { betaTelemetryEnabledForUser } from "@ai-cognitive/product-analytics";

export { PageHeader };

export async function AppShell({ children }: { children: React.ReactNode }) {
  const identity = await resolveWebIdentity();
  const betaTelemetryEnabled = await betaTelemetryEnabledForUser(identity.userId);
  const workspaces = identity.workspaces;
  const workspace = workspaces.find((item) => item.id === identity.workspaceId) ?? workspaces[0];
  if (!workspace) throw new Error("WEB_IDENTITY_WORKSPACE_REQUIRED");

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <div className="brand-lockup">
            <Link href="/studio" className="brand-title">AI Cognitive Studio</Link>
            <div className="brand-subtitle">认知工作室</div>
          </div>
          <StudioNavigation />
          {betaTelemetryEnabled ? <BetaFeedbackButton /> : null}
        </div>

        <div className="sidebar-footer">
          <AccountMenu name={identity.userName || identity.email} email={identity.email} workspace={workspace} workspaces={workspaces} />
        </div>
      </aside>

      <div className="app-frame flex-1">
        <header className="topbar">
          <span className="workspace-name">{workspace.name}</span>
          <Link href="/studio/library#upload" className="btn btn-primary">导入书籍</Link>
        </header>

        <main className="content-area">
          {betaTelemetryEnabled ? <BetaSessionTracker /> : null}
          <StudioNavigation mobile />
          {children}
        </main>
      </div>
    </div>
  );
}
