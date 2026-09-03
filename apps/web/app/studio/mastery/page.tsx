import Link from "next/link";
import { PageHeader } from "@/components/app-shell";
import { resolveWebIdentity } from "@/lib/identity";
import { listMasteryCognitions } from "@/lib/teach-back";
import { displayMastery } from "@/lib/studio-display";
import { cognitionTypeLabels, isCognitionType } from "@/lib/cognitions";
export default async function MasteryPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const identity = await resolveWebIdentity(),
    { cursor } = await searchParams,
    { items, nextCursor } = await listMasteryCognitions(identity, { cursor });
  return (
    <div>
      <PageHeader
        eyebrow="MASTERY"
        title="理解表现"
        description="只展示当前权威认知版本；没有百分比或总分。"
      />
      {items.length ? (
        <div style={{ display: "grid", gap: 12 }}>
          {items.map((row) => (
            <Link
              key={row.id}
              href={
                row.attemptId
                  ? `/studio/teach-back/${row.attemptId}`
                  : `/studio/cognitions/${row.id}/teach-back`
              }
              className="card-panel"
              style={{ color: "inherit", textDecoration: "none" }}
            >
              <div className="meta-badge">
                {displayMastery(row.masteryState)}
              </div>
              <p className="font-serif">{row.content.slice(0, 180)}</p>
              <small>
                {isCognitionType(row.type)
                  ? cognitionTypeLabels[row.type]
                  : "认知"}{" "}
                · {row.sourceTitle}
                {row.assessedAt
                  ? ` · ${new Date(row.assessedAt).toLocaleString("zh-CN")}`
                  : ""}
              </small>
            </Link>
          ))}
        </div>
      ) : (
        <div className="card-panel">当前还没有可复述的认知。</div>
      )}
      {nextCursor ? (
        <p>
          <Link
            className="btn"
            href={`/studio/mastery?cursor=${encodeURIComponent(nextCursor)}`}
          >
            加载更多
          </Link>
        </p>
      ) : null}
    </div>
  );
}
