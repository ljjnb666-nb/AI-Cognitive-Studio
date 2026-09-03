import { notFound } from "next/navigation";
import { PageHeader } from "@/components/app-shell";
import { ThinkingEditor } from "@/components/thinking-editor";
import { CompleteThinkingButton } from "@/components/complete-thinking-button";
import { resolveWebIdentity } from "@/lib/identity";
import { thinkingSessionDetail } from "@/lib/thinking";

export default async function ThinkingSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const [{ sessionId }, identity] = await Promise.all([
    params,
    resolveWebIdentity(),
  ]);
  const session = await thinkingSessionDetail(identity, sessionId);
  if (!session) notFound();
  return (
    <div>
      <PageHeader
        eyebrow="EDITORIAL DIALOGUE"
        title="思考会话"
        description={session.sourceTitle}
      />
      <div className="thinking-detail-layout">
        <section className="thinking-transcript" aria-label="思考记录">
          {session.messages.map((message) => (
            <article
              key={message.id}
              className="card-panel"
              style={{
                borderLeft:
                  message.role === "USER"
                    ? "4px solid var(--primary)"
                    : "4px solid var(--outline)",
              }}
            >
              <div className="meta-badge">
                {message.role === "USER" ? "你的回应" : "思考引导"}
              </div>
              <p
                className="font-serif"
                style={{ whiteSpace: "pre-wrap", lineHeight: 1.65 }}
              >
                {message.content}
              </p>
            </article>
          ))}
          <ThinkingEditor
            sessionId={session.id}
            disabled={session.status === "COMPLETED"}
          />
        </section>
        <aside className="thinking-context">
          <section className="card-panel">
            <h2 className="section-title">认知</h2>
            <p className="font-serif">{session.memoryItem.content}</p>
            <p>
              {session.historical
                ? "这次思考基于该认知的旧版本。"
                : "这是当前认知版本。"}
            </p>
          </section>
          <section className="card-panel">
            <h2 className="section-title">来源证据</h2>
            {session.evidence.length ? (
              session.evidence.map((item, index) => (
                <blockquote key={`${item.blockOrdinal}-${index}`}>
                  “{item.excerpt}”
                </blockquote>
              ))
            ) : (
              <p>暂无可验证来源证据</p>
            )}
          </section>
          {session.status === "COMPLETED" ? (
            <section className="card-panel">这次思考已结束。</section>
          ) : (
            <CompleteThinkingButton sessionId={session.id} />
          )}
        </aside>
      </div>
    </div>
  );
}
