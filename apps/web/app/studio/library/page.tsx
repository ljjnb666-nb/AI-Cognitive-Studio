import Link from "next/link";
import { PageHeader, Status } from "@/components/app-shell";
import { sources, statusLabel } from "@/lib/product";
import { UploadPanel } from "@/components/upload-panel";

export default async function LibraryPage() { const items=await sources(); return <><PageHeader title="知识库" description="原书、解析状态与深度理解都在这里。" action={<a className="button" href="#upload">上传一本书</a>} /><section id="upload" className="panel"><UploadPanel /></section><section className="panel"><h2>全部书籍</h2>{items.map(x=><Link className="source-card" href={`/studio/library/${x.id}`} key={x.id}><div><strong>{x.title}</strong><p>{x.mediaType} · {new Date(x.createdAt).toLocaleDateString("zh-CN")}</p></div><Status value={x.hasIntelligence?"可生成内容":statusLabel(x.status,x.errorCode)} /></Link>)}{!items.length&&<p className="muted">上传第一本书，开始构建你的知识库。</p>}</section></>; }
