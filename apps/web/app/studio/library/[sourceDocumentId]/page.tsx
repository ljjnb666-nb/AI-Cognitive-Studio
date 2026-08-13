import Link from "next/link";
import { PageHeader, Status } from "@/components/app-shell";
import { sourceDetail, statusLabel } from "@/lib/product";

const names: Record<string, string> = { SUMMARY: "核心观点", CONCEPT: "关键概念", ARGUMENT: "主要论证", CLAIM: "重要证据", QUESTION: "值得质疑的地方", COUNTERPOINT: "值得质疑的地方", EXAMPLE: "案例", STORY: "故事", QUOTE: "重要证据" };

export default async function SourcePage({ params }: { params: Promise<{ sourceDocumentId: string }> }) {
  const { sourceDocumentId } = await params;
  const item = await sourceDetail(sourceDocumentId);
  const memories = item.currentIntelligence?.analysisRun.memoryItems ?? [];
  const error = item.ingestionRuns[0]?.errorCode;
  return <>
    <PageHeader title={item.source.displayName} description={`${item.mediaType} · 版本 ${item.version}`} action={item.currentIntelligence ? <span className="actions"><Link className="button secondary" href={`/studio/podcasts/new?source=${item.id}`}>生成播客</Link><Link className="button" href={`/studio/videos/new?source=${item.id}`}>生成短视频</Link></span> : undefined} />
    <section className="panel"><h2>处理状态</h2><Status value={item.currentIntelligence ? "理解完成" : statusLabel(item.ingestionRuns[0]?.status ?? "QUEUED", error)} />
      {error && <p className="muted">{error === "PASSWORD_REQUIRED" ? "该 PDF 需要密码，目前无法处理" : error === "OCR_REQUIRED" ? "文件主要由扫描图片组成，需要 OCR" : "当前处理未完成，可稍后查看。"}</p>}</section>
    {item.currentIntelligence && <section className="panel"><h2>深度理解</h2><div className="memory-grid">{memories.map(memory => <article key={memory.id} className="memory"><p className="eyebrow">{names[memory.type] ?? "Book Memory"}</p><p>{memory.content}</p>{memory.evidence.map(evidence => <details key={evidence.id}><summary>查看原文证据</summary><blockquote>{evidence.sourceBlock.text.slice(evidence.startOffset, evidence.endOffset)}</blockquote></details>)}</article>)}</div>{!memories.length && <p className="muted">分析已完成，但没有可呈现的 Book Memory。</p>}</section>}
    <section className="panel"><h2>内容结构</h2>{item.currentExtraction?.extraction.structureNodes.map(node => <p key={node.id} className="structure">{node.title ?? node.kind}</p>) ?? <p className="muted">等待解析完成后显示。</p>}</section>
  </>;
}
