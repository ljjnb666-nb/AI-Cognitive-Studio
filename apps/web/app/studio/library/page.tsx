import { Suspense } from "react";
import {resolveWebIdentity} from "@/lib/identity";
import {prisma} from "@ai-cognitive/db";
import { sources } from "@/lib/product";
import { LibraryView } from "@/components/library-view";
import { ListPagination, listPage, queryValue } from "@/components/list-pagination";

// Keep the list's original loading skeleton scoped to the index page only.
 // A segment-level library/loading.tsx also wraps private /studio/library/[id],
 // streams 200 before notFound() can set 404, and breaks tenant isolation's
 // HTTP status contract. The detail page must authorize before streaming.
export default function LibraryPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <Suspense fallback={<section className="source-empty-state" role="status" aria-busy="true">
    <h2>正在读取书籍</h2>
    <p>正在加载原文与最新处理状态…</p>
  </section>}><LibraryList {...props} /></Suspense>;
}

async function LibraryList({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await resolveWebIdentity();
  const member = await prisma.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId:identity.workspaceId,userId:identity.userId}},select:{role:true}});
  const raw = await searchParams;
  const query = { q: queryValue(raw.q), format: queryValue(raw.format), status: queryValue(raw.status) };
  const page = listPage(raw.page);
  const items = await sources(identity, { ...query, page, pageSize: 20, lookahead: true });
  return <><LibraryView key={JSON.stringify(query)} items={items.slice(0, 20)} canDelete={member?.role === "OWNER" || member?.role === "EDITOR"} query={query} page={page} /><ListPagination page={page} hasNext={items.length > 20} path="/studio/library" query={Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === "string"))} /></>;
}
