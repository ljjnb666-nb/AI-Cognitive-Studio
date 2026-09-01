import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app-shell";
import { TeachBackEditor } from "@/components/teach-back-editor";
import { recoverPendingTeachBackAttempt } from "@/lib/teach-back";
import { cognitionDetail, cognitionTypeLabels } from "@/lib/cognitions";
import { resolveWebIdentity } from "@/lib/identity";
import { providerReadiness } from "@/lib/provider-product";
export default async function TeachBackPage({ params }: { params: Promise<{ cognitionId: string }> }) { const [{ cognitionId }, identity] = await Promise.all([params, resolveWebIdentity()]); const [cognition, readiness] = await Promise.all([cognitionDetail(identity, cognitionId), providerReadiness(identity.workspaceId)]); if (!cognition) notFound(); const pending = await recoverPendingTeachBackAttempt(identity, cognition.id); return <div><PageHeader eyebrow="TEACH BACK" title="用自己的话讲一遍" description={`${cognitionTypeLabels[cognition.type]} · ${cognition.sourceTitle}`} /><section className="card-panel" style={{ marginBottom: 20 }}><p className="font-serif" style={{ whiteSpace: "pre-wrap" }}>{cognition.content}</p></section>{readiness.mastery.state !== "READY" && !pending ? <section className="card-panel"><p>复述评估尚未就绪，请先配置 Provider。</p><a className="btn btn-primary" href="/studio/settings/providers">前往 Provider 设置</a></section> : <section className="card-panel"><TeachBackEditor memoryItemId={cognition.id} pendingAttempt={pending ?? undefined} /></section>}</div>; }
