import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { prisma } from "@ai-cognitive/db";
import { sourceDetail } from "@/lib/product";
import { projectBookDisplay } from "@/lib/book-display";
import { projectPdfPageEvidence } from "@/lib/pdf-page-review";
import { projectStoredPdfVisualCandidate } from "@/lib/pdf-visual-candidate";
import { readOcrStructureReviewEvidence } from "@ai-cognitive/ingestion";
import { storage } from "@/lib/storage";
import {OcrModelReviewRequest} from "@/components/ocr-model-review-request";
import { PdfVisualReviewRequestForm } from "@/components/pdf-visual-review-request";

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
  const pending=source.ingestionRuns[0];
  if(pending?.status==="OCR_REQUIRED" && pending.errorCode==="SOURCE_OCR_REVIEW_REQUIRED") {
    const evidence=await readOcrStructureReviewEvidence({workspaceId:source.workspaceId,sourceDocumentId:source.id,ingestionRunId:pending.id,physicalPageIndex},storage()).catch(()=>null);
    if(!evidence)notFound();
    const modelReview=await prisma.ocrModelReviewEvent.findFirst({where:{workspaceId:source.workspaceId,receiptId:evidence.receiptId,sourcePdfSha256:evidence.sourcePdfSha256,ocrTextSha256:evidence.textSha256,physicalPageIndex},orderBy:{createdAt:"desc"}});
    const reviewJob=await prisma.job.findFirst({where:{workspaceId:source.workspaceId,type:"pdf.ocr.structure-review",payload:{path:["receiptId"],equals:evidence.receiptId}},orderBy:[{createdAt:"desc"},{id:"desc"}],select:{id:true,status:true}});
    return <main className="container" style={{maxWidth:1150,margin:"0 auto",padding:24}}>
      <Link href={`/studio/library/${source.id}`}>返回书籍详情</Link>
      <h1>{title} · 来源与结构审核</h1>
      <p role="status">{modelReview?"独立模型审核已完成 · 尚未获得播客素材授权":"OCR 已完成 · 结构尚未独立审核 · 不得进入正式播客素材"}</p>
      <p>第 {physicalPageIndex+1} 物理页 · actualTier：{evidence.actualTier}</p>
      <p style={{overflowWrap:"anywhere"}}>原书 SHA256：{evidence.sourcePdfSha256}<br/>模型：{evidence.modelRevision}<br/>模型清单：{evidence.manifestDigest}</p>
      <OcrModelReviewRequest sourceDocumentId={source.id} ingestionRunId={pending.id} physicalPageIndex={physicalPageIndex} receiptId={evidence.receiptId} textSha256={evidence.textSha256} sourcePdfSha256={evidence.sourcePdfSha256} enabled={process.env.PDF_VISUAL_REVIEW_ON_DEMAND_ENABLED==="true"} existingStatus={reviewJob?.status??null} existingJobId={reviewJob?.id??null}/>
      {modelReview?<section className="card-panel"><h2>模型独立判断：{modelReview.decision==="PASSED"?"通过（仍不可发布）":modelReview.decision==="REJECTED"?"拒绝":"仍需复核"}</h2><p>{modelReview.providerKey} / {modelReview.modelId} · {modelReview.createdAt.toISOString()}</p><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(modelReview.reasons,null,2)}</pre><p>证据摘要：{modelReview.evidenceSha256}</p><p>费用：尚未定价；用量账本已关联调用 {modelReview.invocationId}。</p></section>:null}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(min(100%,420px),1fr))",gap:20}}>
        <section><h2>原始 PDF 页面</h2>
          {process.env.PDF_REVIEW_PRIVATE_TEMP_ROOT?<Image unoptimized loading="eager" width={800} height={1100} alt={`原始 PDF 第 ${physicalPageIndex+1} 物理页`} src={`/api/studio/pdf-visual-review/${source.id}/source-page?run=${pending.id}&page=${physicalPageIndex}&sha=${evidence.sourcePdfSha256}&receipt=${evidence.receiptId}`} style={{width:"100%",height:"auto"}}/>:null}
          <p><a href={`/api/studio/pdf-visual-review/${source.id}/source-pdf?sha=${evidence.sourcePdfSha256}#page=${physicalPageIndex+1}`} target="_blank" rel="noreferrer">打开原始 PDF 第 {physicalPageIndex+1} 物理页</a></p>
        </section>
        <section><h2>OCR 输出及顺序</h2><p>按 OCR 输出顺序显示；阅读顺序未经独立验证。定位框、表格、图表、公式细节均未知。</p>
          {evidence.blocks.slice(0,32).map(block=><article key={block.ordinal}><h3>区块 {block.ordinal+1}</h3><p style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{block.text.slice(0,6000)}</p></article>)}
          <p>预览最多 32 块，每块 6000 字符；不代表结构完整或准确。</p>
          <p>质量风险：{JSON.stringify(evidence.qualityDecision)}</p>
        </section>
      </div>
    </main>;
  }
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
      physicalPageIndex: true, sourcePdfSha256: true, sourcePngSha256: true,
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
        <p>只有明确授权后保存、与当前解析版本和物理页绑定、且未过期的图表候选可以只读展示。图结构仍未经独立审核，不代表已获准引用或发布。</p>
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
          <PdfVisualReviewRequestForm sourceDocumentId={source.id} serverEnabled={process.env.PDF_MIXED_GRAPH_REVIEW_REQUEST_ENABLED==="true"}/>
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
              <div role="status" style={{ fontWeight: 600 }}>未审核 · 不得作为播客事实依据</div>
              <p style={{ marginBottom: 0, color: "var(--text-secondary)" }}>需与原始 PDF 图像人工对照。此页面没有“批准”按钮，不会修改提取记录或播客素材。</p>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
