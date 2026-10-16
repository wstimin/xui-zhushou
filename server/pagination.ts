import type { Request } from 'express';
import type { PanelArkDatabase, DbRow } from './panelark-db.js';
import type { SqlValue } from 'sql.js';

export function pagination(query: Request['query'], total: number) {
  const integer = (value: unknown, fallback: number) => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  const pageSize = Math.min(100, integer(query.pageSize, 20));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { page: Math.min(totalPages, integer(query.page, 1)), pageSize, total, totalPages };
}

export function pagedSql(db: PanelArkDatabase, req: Request, select: string, count: string, params: SqlValue[] = [], selectParams: SqlValue[] = params) {
  const meta = pagination(req.query, Number(db.get<DbRow>(count, params)?.total || 0));
  const items = db.all(`${select} LIMIT ? OFFSET ?`, [...selectParams, meta.pageSize, (meta.page - 1) * meta.pageSize]);
  return { items, pagination: meta };
}
