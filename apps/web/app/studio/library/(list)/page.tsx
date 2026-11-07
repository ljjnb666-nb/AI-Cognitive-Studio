import {resolveWebIdentity} from "@/lib/identity";
import {prisma} from "@ai-cognitive/db";
import { sources } from "@/lib/product";
import { LibraryView } from "@/components/library-view";
import { ListPagination, listPage, queryValue } from "@/components/list-pagination";

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const identity = await resolveWebIdentity();
  const member = await prisma.workspaceMember.findUnique({where:{workspaceId_userId:{workspaceId:identity.workspaceId,userId:identity.userId}},select:{role:true}});
  const raw = await searchParams;
  const query = { q: queryValue(raw.q), format: queryValue(raw.format), status: queryValue(raw.status) };
  const page = listPage(raw.page);
  const items = await sources(identity, { ...query, page, pageSize: 20, lookahead: true });
  return <><LibraryView key={JSON.stringify(query)} items={items.slice(0, 20)} canDelete={member?.role === "OWNER" || member?.role === "EDITOR"} query={query} page={page} /><ListPagination page={page} hasNext={items.length > 20} path="/studio/library" query={Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === "string"))} /></>;
}
