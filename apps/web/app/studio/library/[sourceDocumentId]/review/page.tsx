import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@ai-cognitive/db";
import { sourceDetail } from "@/lib/product";
import { projectBookDisplay } from "@/lib/book-display";
import { projectPdfPageEvidence } from "@/lib/pdf-page-review";
import { projectStoredPdfVisualCandidate } from "@/lib/pdf-visual-candidate";
import { PdfVisualReviewRequestForm } from "@/components/pdf-visual-review-request";
import { PdfHumanGraphReviewForm } from "@/components/pdf-human-graph-review";
import { resolveWebIdentity } from "@/lib/identity";

export default async function PdfSourceReviewPage({
  params, searchParams,
}: {
  params: Promise<{ sourceDocumentId: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { sourceDocumentId } = await params;
  let source: Awaited<ReturnType<typeof sourceDetail>>;
  try {
    // Workspace membership and document identity must be checked before
    // retrieving any source text or source-page metadata.
    source = await sourceDetail(sourceDocumentId);
  } catch (error) {
    if (error instanceof Error && error.message === "SOURCE_DOCUMENT_ACCESS_DENIED") notFound();
    throw error;
  }
  if (source.mediaType !== "application/pdf") notFound();

  const rawPage = (await searchParams).page;
  if (rawPage !== undefined &&
      (typeof rawPage !== "string" || !/^(0|[1-9]\d{0,3})$/.test(rawPage) ||
       Number(rawPage) > 1999)) notFound();
  const physicalPageIndex = typeof rawPage === "string" ? Number(rawPage) : 0;
  const title = projectBookDisplay({
    fileName: source.source.displayName,
    workTitle: source.source.edition?.work.title,
    version: source.version,
    isLatestVersion: source.source.documents[0]?.id === source.id,
  }).title;
  const current = source.currentExtraction;
  const extractionId = current?.extractionId;
  const pages = extractionId ? await prisma.sourcePage.count({
    where: { extractionId },
  }) : 0;
  const sourcePage = extractionId ? await prisma.sourcePage.findFirst({
    where: { extractionId, physicalPageIndex },
    select: { id: true, physicalPageIndex: true, printedPageLabel: true },
  }) : null;
  const sourceBlockCount = extractionId && sourcePage ? await prisma.sourceBlock.count({
    where: { extractionId, sourcePageId: sourcePage.id },
  }) : 0;
  const blocks = extractionId && sourcePage ? await prisma.sourceBlock.findMany({
    where: { extractionId, sourcePageId: sourcePage.id },
    select: { id: true, ordinal: true, kind: true, text: true },
    orderBy: { ordinal: "asc" },
    take: 17,
  }) : [];
  const evidence = sourcePage && sourcePage.physicalPageIndex !== null
    ? projectPdfPageEvidence({
      sourceSha256: source.sha256,
      physicalPageIndex,
      recordedPageIndex: sourcePage.physicalPageIndex,
      sourceBlockCount,
      blocks,
    }) : null;
  // No user-supplied candidate ID or model invocation can be reached here.
  // Bind the candidate to the current extraction/run, exact source SHA and page.
  const matchingRun = current ? await prisma.ingestionRun.findFirst({
    where: { id: current.extraction.ingestionRunId, sourceDocumentId: source.id,
      workspaceId: source.workspaceId, status: "SUCCEEDED" },
    select: { routingGeneration: true },
  }) : null;
  const row = matchingRun?.routingGeneration ? await prisma.pdfVisualReviewCandidate.findFirst({
    where: {
      workspaceId: source.workspaceId, sourceDocumentId: source.id,
      ingestionRunId: current!.extraction.ingestionRunId,
      routingGeneration: matchingRun.routingGeneration,
      physicalPageIndex, sourcePdfSha256: source.sha256,
      expiresAt: { gt: new Date() },
    },
    select: {
      id: true, physicalPageIndex: true, sourcePdfSha256: true, sourcePngSha256: true,
      routingGeneration: true, candidateJson: true, candidateSha256: true, expiresAt: true,
    },
    orderBy: { createdAt: "desc" },
  }) : null;
  let visual: ReturnType<typeof projectStoredPdfVisualCandidate> = null;
  let visualInvalid = false;
  try {
    visual = projectStoredPdfVisualCandidate(row,
      { physicalPageIndex, sourcePdfSha256: source.sha256, routingGeneration: matchingRun?.routingGeneration ?? 0 });
  } catch {
    // Corrupt or stale model evidence must never become a reviewed fact.
    visualInvalid = true;
  }
  const reviewEvent = visual && row ? await prisma.pdfVisualHumanReviewEvent.findFirst({
    where: { candidateId: row.id, workspaceId: source.workspaceId, sourceDocumentId: source.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, action: true, reviewerUserId: true, createdAt: true },
  }) : null;
  const identity = visual ? await resolveWebIdentity() : null;
  const reviewer = identity ? await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: source.workspaceId, userId: identity.userId } },
    select: { role: true },
  }) : null;
  const canDecide = Boolean(reviewer && reviewer.role !== "VIEWER");
  const pageHref = (page: number) => `/studio/library/${source.id}/review?page=${page}`;
  return (
    <main className="container" style={{ maxWidth: 1150, margin: "0 auto", padding: "28px 20px 60px" }}>
      <Link href={`/studio/library/${source.id}`} className="btn btn-secondary" style={{ marginBottom: 20 }}>
        返回书籍详情
      </Link>
      <div className="page-eyebrow">PDF 来源与图表人工核对</div>
      <h1 className="font-serif" style={{ fontSize: 30, overflowWrap: "anywhere", margin: "10px 0" }}>
        {title}
      </h1>
      <p style={{ color: "var(--text-secondary)", overflowWrap: "anywhere" }}>
        原文件：{source.source.displayName} · 版本 v{source.version}
      </p>
      <div className="card-panel" style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>审核权限边界</h2>
        <p>此页面读取当前已存档的 PDF 解析区块，仅供核对原文来源。<strong>解析成功不等于人工核准，更不等于独立 Gold。</strong></p>
        <p>图表内容只展示已获授权、与当前解析版本绑定、且未过期的短期候选。即使出现图表节点与关系，也仍然未经人工核验，不具备播客引用资格。</p>
        <p style={{ fontSize: 13, marginBottom: 0 }}>
          解析器：{current?.extraction.parserName ?? "尚无结果"} / {current?.extraction.parserVersion ?? "—"} ·
          原书 SHA256：<code style={{ overflowWrap: "anywhere" }}>{source.sha256}</code>
        </p>
      </div>
      {current && <PdfVisualReviewRequestForm sourceDocumentId={source.id} serverEnabled={process.env.PDF_VISUAL_REVIEW_ON_DEMAND_ENABLED === "true"} />}
      {!current ? (
        <section className="card-panel" role="status">
          <h2 style={{ fontSize: 18 }}>暂无可审阅的 PDF 提取记录</h2>
          <p>书籍尚未完成来源解析。该状态不会自动创建视觉任务，也不会调用付费模型。</p>
        </section>
      ) : (
        <>
          <nav aria-label="PDF 物理页切换" className="card-panel" style={{
            display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between",
            gap: 12, marginBottom: 20,
          }}>
            <span>第 <strong>{physicalPageIndex + 1}</strong> 物理页 · 当前提取记录共 {pages} 页</span>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {physicalPageIndex > 0 ? <Link href={pageHref(physicalPageIndex - 1)} className="btn btn-secondary">上一页</Link> : null}
              {physicalPageIndex + 1 < pages ? <Link href={pageHref(physicalPageIndex + 1)} className="btn btn-secondary">下一页</Link> : null}
            </div>
          </nav>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: 20 }}>
            <section className="card-panel" aria-labelledby="pdf-source-text-heading">
              <h2 id="pdf-source-text-heading" style={{ fontSize: 20, marginTop: 0 }}>原文区块 · 未独立核准</h2>
              {sourcePage?.printedPageLabel ? <p>印刷页码：{sourcePage.printedPageLabel}（与 PDF 物理页不同）</p> : null}
              {evidence ? (
                <>
                  <p style={{ color: "var(--text-secondary)" }}>
                    来源：当前正式提取记录 · 该页 {evidence.sourceBlockCount} 个区块 · 展示 {evidence.parsedBlocks.length} 个
                    {evidence.previewTruncated ? "（有截断，仅为预览）" : ""}
                  </p>
                  {evidence.parsedBlocks.map((block) => (
                    <article key={block.id} style={{
                      borderTop: "1px solid var(--outline-variant, #d4d4d4)", padding: "15px 0",
                    }}>
                      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
                        区块 #{block.ordinal + 1} · {block.kind} · {block.originalCharacters} 字符
                        {block.excerptTruncated ? " · 已截断" : ""}
                      </div>
                      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>
                        {block.excerpt || "（空区块）"}
                      </p>
                    </article>
                  ))}
                  {!evidence.parsedBlocks.length ? <p>此页没有已存档的正文区块，不能以此认定原页没有文字。</p> : null}
                  {evidence.previewTruncated ? <p role="status">只显示最多 16 个区块、6,000 字符的预览；核对整页需要继续检查原始 PDF。</p> : null}
                </>
              ) : (
                <p role="status">此物理页没有对应的已存档来源页。可能是 OCR 待处理或旧版提取记录缺失，不应据此推断原书为空白。</p>
              )}
            </section>
            <div style={{ display: "grid", gridTemplateColumns: visual ? "repeat(auto-fit, minmax(min(100%, 440px), 1fr))" : "1fr", gap: 20, alignItems: "start" }}>
            {visual ? (
              <section className="card-panel" aria-labelledby="pdf-human-original-heading">
                <h2 id="pdf-human-original-heading" style={{ fontSize: 20, marginTop: 0 }}>原始 PDF · 第 {physicalPageIndex + 1} 物理页</h2>
                <p>页面来自已验证 SHA 的私有原书。可在原页上定位图表位置，必要时放大浏览。这里不是 AI 生成图。</p>
                <iframe
                  title={"已授权原始 PDF，物理页 " + (physicalPageIndex + 1)}
                  src={"/api/studio/pdf-visual-review/" + source.id + "/source-pdf#page=" + (physicalPageIndex + 1)}
                  style={{ width: "100%", height: 620, border: "1px solid var(--outline-variant,#d4d4d4)" }}
                  loading="lazy"
                />
                <p style={{ fontSize: 13 }}>如果浏览器不支持内嵌 PDF，请
                  {" "}<a href={"/api/studio/pdf-visual-review/" + source.id + "/source-pdf#page=" + (physicalPageIndex + 1)}
                    target="_blank" rel="noopener noreferrer">在新标签页查看原始 PDF</a>。
                </p>
                <p style={{ fontSize: 12 }}>原书只通过工作区授权接口返回，不生成公开分享链接。大文件可能加载较慢。</p>
              </section>
            ) : null}
            <section className="card-panel" aria-labelledby="pdf-visual-review-heading">
              <h2 id="pdf-visual-review-heading" style={{ fontSize: 20, marginTop: 0 }}>图表与关系 · 模型候选（未人工核验）</h2>
              {visual ? (
                <>
                  <p role="status">存在 {visual.figures.length} 个待核验图表候选；不代表原图准确、完整或可发布。</p>
                  <p style={{ overflowWrap: "anywhere", fontSize: 12, color: "var(--text-secondary)" }}>
                    来源 PNG SHA256：<code>{visual.sourcePngSha256}</code> · 候选过期时间：{visual.expiresAt}
                  </p>
                  {visual.figures.map(figure => (
                    <article key={figure.id} style={{ padding: "15px 0", borderTop: "1px solid var(--outline-variant, #d4d4d4)" }}>
                      <h3 style={{ fontSize: 17, margin: "0 0 8px" }}>{figure.kind} · {figure.id}</h3>
                      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>模型识别说明（未经核验）：{figure.caption || "无"}</p>
                      <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>页面定位框（千分比）：[{figure.bbox.join(", ")}]</p>
                      <h4 style={{ fontSize: 14 }}>识别的节点</h4>
                      <ul>{figure.nodes.map(node => <li key={node.id}>{node.id}：{node.label}</li>)}</ul>
                      <h4 style={{ fontSize: 14 }}>识别的关系</h4>
                      <ul>{figure.edges.map((edge, index) =>
                        <li key={index}>{edge.from} → {edge.to}（{edge.direction}）：{edge.label || "无文字标签"}</li>)}</ul>
                    </article>
                  ))}
                </>
              ) : (
                <p role="status">
                  {visualInvalid
                    ? "该候选的来源或完整性校验未通过，已禁止展示。"
                    : "此页没有可读取的有效候选：可能尚未执行获授权的视觉任务、未检测到图表，或记录已经过期。"}
                </p>
              )}
              <div role="status" style={{ fontWeight: 600 }}>
                {reviewEvent?.action === "CONFIRM_STRUCTURE"
                  ? "人工已确认结构 · 仍不得直接进入播客"
                  : reviewEvent?.action === "REJECT_STRUCTURE"
                  ? "人工已驳回结构 · 不得进入播客"
                  : reviewEvent?.action === "WITHDRAW"
                  ? "已撤回人工结论 · 等待重新审核"
                  : "未审核 · 不得作为播客事实依据"}
              </div>
              {reviewEvent ? <p style={{fontSize:12,color:"var(--text-secondary)"}}>
                最近审核记录：{reviewEvent.createdAt.toISOString()} · 审核人 {reviewEvent.reviewerUserId}
              </p> : null}
              {visual && row ? (
                <PdfHumanGraphReviewForm
                  key={reviewEvent?.id ?? "initial"}
                  sourceDocumentId={source.id}
                  candidateId={row.id}
                  candidateSha256={row.candidateSha256}
                  previousEventId={reviewEvent?.id ?? null}
                  previousAction={reviewEvent?.action ?? null}
                  canDecide={canDecide}
                />
              ) : null}
              <p style={{ marginBottom: 0, color: "var(--text-secondary)" }}>
                人工确认仅记录本次模型候选的结构判断，不修改 canonical SourceBlock、独立 Gold、Book Intelligence 或播客素材。
              </p>
            </section>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
