import Link from "next/link";
import { PageHeader, Status } from "@/components/app-shell";
import { dashboard,statusLabel } from "@/lib/product";
export default async function Podcasts(){const data=await dashboard();return <><PageHeader title="播客" description="以原书证据为基础的多主持人对话。" action={<Link className="button" href="/studio/podcasts/new">生成播客</Link>}/><section className="panel">{data.podcasts.map(p=><Link className="source-card" href={p.href} key={p.id}><strong>{p.title}</strong><Status value={statusLabel(p.status,p.errorCode)}/></Link>)}{!data.podcasts.length&&<p className="muted">选择已完成理解的书，即可开始生成播客。</p>}</section></>}
