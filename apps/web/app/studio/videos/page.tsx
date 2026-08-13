import Link from "next/link";
import { PageHeader, Status } from "@/components/app-shell";
import { dashboard,statusLabel } from "@/lib/product";
export default async function Videos(){const data=await dashboard();return <><PageHeader title="短视频" description="从书中提炼观点、叙事与证据。" action={<Link className="button" href="/studio/videos/new">生成短视频</Link>}/><section className="panel">{data.videos.map(v=><Link className="source-card" href={v.href} key={v.id}><strong>{v.title}</strong><Status value={statusLabel(v.status,v.errorCode)}/></Link>)}{!data.videos.length&&<p className="muted">选择已完成理解的书，即可开始生成短视频。</p>}</section></>}
