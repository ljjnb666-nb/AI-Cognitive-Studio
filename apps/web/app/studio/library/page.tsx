import { sources } from "@/lib/product";
import { LibraryView } from "@/components/library-view";
import { ListPagination, listPage, queryValue } from "@/components/list-pagination";

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const query = { q: queryValue(raw.q), format: queryValue(raw.format), status: queryValue(raw.status) };
  const page = listPage(raw.page);
  const items = await sources(undefined, { ...query, page, pageSize: 20, lookahead: true });
  return <><LibraryView key={JSON.stringify(query)} items={items.slice(0, 20)} query={query} page={page} /><ListPagination page={page} hasNext={items.length > 20} path="/studio/library" query={Object.fromEntries(Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === "string"))} /></>;
}
