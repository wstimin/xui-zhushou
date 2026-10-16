import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageQuery, PageResult, Pagination } from './api';

export function PaginationControls({ pagination, busy, onPage, onPageSize }: { pagination: Pagination; busy?: boolean; onPage: (page: number) => void; onPageSize: (size: number) => void }) {
  const { page, pageSize, total, totalPages } = pagination;
  return <nav className="admin-pagination" aria-label="列表分页">
    <div><span>共 {total} 条</span><label>每页<select aria-label="每页条数" value={pageSize} disabled={busy} onChange={event => onPageSize(Number(event.target.value))}>{[10, 20, 50, 100].map(size => <option key={size} value={size}>{size} 条</option>)}</select></label></div>
    <div><button className="admin-ghost" disabled={busy || page <= 1} onClick={() => onPage(1)} aria-label="首页">首页</button><button className="admin-ghost" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>上一页</button><span aria-live="polite">{page} / {totalPages}</span><button className="admin-ghost" disabled={busy || page >= totalPages} onClick={() => onPage(page + 1)}>下一页</button><button className="admin-ghost" disabled={busy || page >= totalPages} onClick={() => onPage(totalPages)} aria-label="末页">末页</button></div>
  </nav>;
}

export function usePagedList<T, R extends PageResult<T>>(fetcher: (query: PageQuery) => Promise<R>, notify: (notice: { kind: 'error'; text: string }) => void) {
  const [items, setItems] = useState<T[]>([]);
  const [data, setData] = useState<R | null>(null);
  const [query, setQuery] = useState({ page: 1, pageSize: 20 });
  const [meta, setMeta] = useState<Pagination>({ ...query, total: 0, totalPages: 1 });
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const id = ++sequence.current; setBusy(true);
    try {
      const result = await fetcher(query);
      if (id !== sequence.current) return;
      setItems(result.items); setData(result); setMeta(result.pagination);
      if (query.page !== result.pagination.page) setQuery(current => ({ ...current, page: result.pagination.page }));
    } catch (error) { if (id === sequence.current) notify({ kind: 'error', text: error instanceof Error ? error.message : String(error) }); }
    finally { if (id === sequence.current) setBusy(false); }
  }, [fetcher, query, notify]);
  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);
  const pager = <PaginationControls pagination={meta} busy={busy} onPage={page => setQuery(current => ({ ...current, page }))} onPageSize={pageSize => setQuery({ page: 1, pageSize })} />;
  return { items, setItems, data, pagination: meta, busy, load, pager };
}
