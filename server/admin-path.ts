import { DbRow, PanelArkDatabase } from "./panelark-db.js";

export const DEFAULT_ADMIN_PATH = "/admin";

export function normalizeAdminPath(value: unknown): string {
  const candidate = String(value || "").trim().replace(/\/+$/g, "") || DEFAULT_ADMIN_PATH;
  if (candidate.length > 128 || !/^\/[A-Za-z0-9][A-Za-z0-9_-]{2,63}(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})*$/.test(candidate)) {
    throw new Error("后台路径必须以 / 开头，每段只能包含字母、数字、下划线和短横线，首段至少 3 位");
  }
  if (/^\/(?:api|assets|install)(?:\/|$)/i.test(candidate)) {
    throw new Error("后台路径不能使用 /api、/assets 或 /install 保留路径");
  }
  return candidate;
}

export function readAdminPath(db: PanelArkDatabase): string {
  const stored = db.get<DbRow>("SELECT value FROM site_settings WHERE key = 'admin_path'")?.value;
  try { return normalizeAdminPath(stored || DEFAULT_ADMIN_PATH); }
  catch { return DEFAULT_ADMIN_PATH; }
}

export function isAdminPagePath(requestPath: string, adminPath: string): boolean {
  return requestPath === adminPath || requestPath.startsWith(`${adminPath}/`);
}

export function markAdminHtml(html: string, admin: boolean): string {
  if (!admin) return html;
  return html.replace('id="root"', 'id="root" data-panelark-view="admin"');
}
