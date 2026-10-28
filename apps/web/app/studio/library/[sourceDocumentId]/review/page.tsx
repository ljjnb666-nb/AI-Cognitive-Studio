import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@ai-cognitive/db";
import { sourceDetail } from "@/lib/product";
import { projectBookDisplay } from "@/lib/book-display";
import { projectPdfPageEvidence } from "@/lib/pdf-page-review";

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
  const pageHref = (page: number) => `/studio/library/${source.id}/review?page=${page}`;
  return (
    <main className="container" style={{ maxWidth: 1150, margin: "0 auto", padding: "28px 20px 60px" }}>
      <Link href={`/studio/library/${source.id}`} className="btn btn-secondary" style={{ marginBottom: 20 }}>
        返回书籍详情
      </Link>
      <div className="page-eyebrow">PDF 来源核对 · 只读</div>
      <h1 className="font-serif" style={{ fontSize: 30, overflowWrap: "anywhere", margin: "10px 0" }}>
        {title}
      </h1>
      <p style={{ color: "var(--text-secondary)", overflowWrap: "anywhere" }}>
        原文件：{source.source.displayName} · 版本 v{source.version}
      </p>
      <div className="card-panel" style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>审核权限边界</h2>
        <p>此页面读取当前已存档的 PDF 解析区块，仅供核对原文来源。<strong>解析成功不等于人工核准，更不等于独立 Gold。</strong></p>
        <p>视觉 Worker 的图表候选目前尚未有可供网页读取的持久化审核记录，因此这里不会虚构图表、批准状态或模型置信度。</p>
        <p style={{ fontSize: 13, marginBottom: 0 }}>
          解析器：{current?.extraction.parserName ?? "尚无结果"} / {current?.extraction.parserVersion ?? "—"} ·
          原书 SHA256：<code style={{ overflowWrap: "anywhere" }}>{source.sha256}</code>
        </p>
      </div>
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
            <section className="card-panel" aria-labelledby="pdf-visual-review-heading">
              <h2 id="pdf-visual-review-heading" style={{ fontSize: 20, marginTop: 0 }}>图表与关系 · 待接入审核</h2>
              <p>当前未找到带有可复核来源、可通过网页读取的图表候选。这里不会根据正文自行猜测图表节点或箭头方向。</p>
              <div role="status" style={{ fontWeight: 600 }}>未审核 · 不得作为播客事实依据</div>
              <p style={{ marginBottom: 0, color: "var(--text-secondary)" }}>下一项单独接入经授权的视觉候选回执和审核提交。此页面没有“批准”按钮，不会修改提取记录或播客素材。</p>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
