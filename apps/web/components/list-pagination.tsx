import Link from "next/link";

export function ListPagination({ page, hasNext, path, query = {} }: { page: number; hasNext: boolean; path: string; query?: Record<string, string> }) {
  if (page <= 1 && !hasNext) return null;
  const href = (next: number) => `${path}?${new URLSearchParams({ ...query, page: String(next) })}`;
  return <nav aria-label="列表分页" className="filter-bar">
    {page > 1 && <Link className="btn" href={href(page - 1)}>上一页</Link>}
    <span>第 {page} 页</span>
    {hasNext && <Link className="btn" href={href(page + 1)}>下一页</Link>}
  </nav>;
}

export function queryValue(value?: string | string[]) { return Array.isArray(value) ? value[0] : value; }
export function listPage(value?: string | string[]) {
  const raw = queryValue(value);
  return raw && /^\d+$/.test(raw) ? Math.min(10000, Math.max(1, Number(raw))) : 1;
}
