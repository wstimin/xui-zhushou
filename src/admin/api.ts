export type AdminRole = 'super_admin' | 'operator' | 'support';

export interface AdminIdentity { id: string; username: string; role: AdminRole; totpEnabled?: boolean }
export interface AdminRecord extends AdminIdentity { enabled: number; created_at: string; updated_at: string }
export interface DashboardStats { totalCdks: number; activeCdks: number; consumed: number; locked: number; jobsPendingReview: number; resourceClicks: number }
export interface PackageRecord {
  id: string; name: string; description: string; max_uses: number; allowed_panel?: string;
  allowed_category?: string; validity_days?: number; enabled: number; created_at: string;
}
export interface CdkRecord {
  id: string; code_hint: string; used_count: number; status: 'active' | 'disabled' | 'refunded';
  expires_at?: string; created_at: string; package_name: string; max_uses: number; locked_count: number;
  batch_id?: string; batch_name?: string; package_id: string; code_available: number;
}
export interface CdkFilters { search?: string; status?: string; packageId?: string; batchId?: string }
export interface CdkSelection { ids?: string[]; scope?: 'filtered'; filters?: CdkFilters }
export interface CdkBatch { id: string; name: string; quantity: number; package_id: string; package_name: string; created_at: string }
export interface CdkExport { success: true; filename: string; mime: string; content: string; total: number; exported: number; unavailable: number }
export interface AuditRecord {
  id: number; username?: string; action: string; target_type?: string; target_id?: string;
  ip?: string; details?: string; created_at: string;
}
export interface AdminSettings {
  purchaseEnabled: boolean; purchaseButtonText: string; purchaseUrl: string; supportUrl: string; siteNotice: string; adminPath: string;
}
export interface CatalogAdminRecord { id: string; name: string; kind: 'panel' | 'tool'; category: string; description: string; enabled: boolean; sortOrder: number }
export interface ResourceRecord { id: string; type: 'vps' | 'domain' | 'cdn' | 'other'; title: string; description: string; badge: string; url: string; enabled: number; sort_order: number; click_count: number }
export interface JobReviewRecord { id: string; kind: string; status: string; recovery_status: string; progress: number; error_message?: string; task_key?: string; created_at: string; updated_at: string; review_status?: string; refund_status?: string; note?: string }
export interface SessionRecord { id: string; ip?: string; user_agent?: string; created_at: string; last_seen_at: string; expires_at: string }
export interface BackupRecord { id: string; filename: string; reason: string; size_bytes: number; created_at: string }
export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'prepared' | 'applying' | 'restarting' | 'completed' | 'rolled_back' | 'failed';
  progress: number; currentVersion: string; targetVersion?: string; channel: 'stable'; message: string;
  checkedAt?: string; updatedAt: string; preUpdateBackup?: string; error?: string;
  manifest?: { version: string; publishedAt: string; notes: string[]; adapterCatalog?: { version: string } };
  events: Array<{ phase: string; progress: number; message: string; at: string }>;
}
export interface SecurityReport { generatedAt: string; production: boolean; summary: 'pass' | 'warning' | 'fail'; failed: number; warnings: number; checks: Array<{ id: string; label: string; status: 'pass' | 'warning' | 'fail'; detail: string }> }

export interface Pagination { page: number; pageSize: number; total: number; totalPages: number }
export interface PageQuery { page?: number; pageSize?: number }
export interface PageResult<T> { success: true; items: T[]; pagination: Pagination }
const pagePath = (path: string, query: PageQuery = {}) => `${path}?${new URLSearchParams({ page: String(query.page || 1), pageSize: String(query.pageSize || 20) })}`;

let csrfToken = '';

type ApiOptions = RequestInit & { csrf?: boolean };

export class AdminApiError extends Error {
  constructor(message: string, readonly code?: string) { super(message); this.name = 'AdminApiError'; }
}

async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (options.csrf !== false && options.method && !['GET', 'HEAD'].includes(options.method)) {
    if (csrfToken) headers.set('x-csrf-token', csrfToken);
  }
  const response = await fetch(`/api/admin${path}`, { ...options, cache: 'no-store', headers, credentials: 'same-origin' });
  const body = await response.json().catch(() => ({})) as T & { error?: string; code?: string; csrfToken?: string };
  if (!response.ok) throw new AdminApiError(body.error || `请求失败（${response.status}）`, body.code);
  if (body.csrfToken) csrfToken = body.csrfToken;
  return body;
}

export async function allPackageOptions() {
  const items: PackageRecord[] = [];
  for (let page = 1; ; page += 1) {
    const result = await adminApi.packages({ page, pageSize: 100 }); items.push(...result.items);
    if (page >= result.pagination.totalPages) return items;
  }
}

export const adminApi = {
  bootstrapState: () => api<{ success: true; required: boolean; setupTokenRequired: boolean }>('/bootstrap', { csrf: false }),
  bootstrap: (setupToken: string, username: string, password: string) => api<{ success: true; admin: AdminIdentity; csrfToken: string }>('/bootstrap', { method: 'POST', body: JSON.stringify({ setupToken, username, password }), csrf: false }),
  login: (username: string, password: string, totpCode?: string) => api<{ success: true; admin: AdminIdentity; csrfToken: string }>('/login', { method: 'POST', body: JSON.stringify({ username, password, totpCode }), csrf: false }),
  session: () => api<{ success: true; admin: AdminIdentity; csrfToken: string }>('/session'),
  logout: () => api<{ success: true }>('/logout', { method: 'POST' }),
  dashboard: () => api<{ success: true; stats: DashboardStats }>('/dashboard'),
  packages: (query: PageQuery = {}) => api<PageResult<PackageRecord>>(pagePath('/packages', query)),
  createPackage: (payload: Record<string, unknown>) => api<{ success: true; id: string }>('/packages', { method: 'POST', body: JSON.stringify(payload) }),
  updatePackage: (id: string, enabled: boolean) => api<{ success: true }>(`/packages/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  createBatch: (payload: { packageId: string; name: string; quantity: number }) => api<{ success: true; batchId: string; codes: string[]; warning: string }>('/batches', { method: 'POST', body: JSON.stringify(payload) }),
  cdks: (query: PageQuery & CdkFilters = {}) => api<PageResult<CdkRecord>>(`${pagePath('/cdks', query)}&${new URLSearchParams({ search: query.search || '', status: query.status || '', packageId: query.packageId || '', batchId: query.batchId || '' })}`),
  batches: (query: PageQuery = {}) => api<PageResult<CdkBatch>>(pagePath('/batches', query)),
  revealCdk: (id: string) => api<{ success: true; code: string }>(`/cdks/${id}/reveal`, { method: 'POST', body: '{}' }),
  exportCdks: (selection: CdkSelection & { format: 'txt' | 'csv' }) => api<CdkExport>('/cdks/export', { method: 'POST', body: JSON.stringify(selection) }),
  bulkCdks: (selection: CdkSelection & { action: 'status' | 'delete'; status?: CdkRecord['status'] }) => api<{ success: true; affected: number }>('/cdks/bulk', { method: 'POST', body: JSON.stringify(selection) }),
  updateCdk: (id: string, payload: CdkRecord['status'] | { status: CdkRecord['status']; maxUses: number; usedCount: number; expiresAt: string | null; originalCode?: string }) => api<{ success: true }>(`/cdks/${id}`, { method: 'PATCH', body: JSON.stringify(typeof payload === 'string' ? { status: payload } : payload) }),
  deleteCdk: (id: string) => api<{ success: true; affected: number }>(`/cdks/${id}`, { method: 'DELETE' }),
  settings: () => api<{ success: true } & AdminSettings>('/settings'),
  updateSettings: (payload: AdminSettings) => api<{ success: true } & AdminSettings>('/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  admins: (query: PageQuery = {}) => api<PageResult<AdminRecord>>(pagePath('/admins', query)),
  createAdmin: (payload: { username: string; password: string; role: AdminRole }) => api<{ success: true; id: string }>('/admins', { method: 'POST', body: JSON.stringify(payload) }),
  updateAdmin: (id: string, payload: { role: AdminRole; enabled: boolean }) => api<{ success: true }>(`/admins/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  updateAccount: (payload: { currentPassword: string; username?: string; newPassword?: string }) => api<{ success: true; admin: AdminIdentity }>('/account', { method: 'PUT', body: JSON.stringify(payload) }),
  audit: (query: PageQuery = {}) => api<PageResult<AuditRecord>>(pagePath('/audit', query)),
  catalog: (query: PageQuery = {}) => api<PageResult<CatalogAdminRecord>>(pagePath('/catalog', query)),
  updateCatalog: (id: string, payload: Partial<CatalogAdminRecord>) => api<{ success: true; item: CatalogAdminRecord }>(`/catalog/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  resources: (query: PageQuery = {}) => api<PageResult<ResourceRecord>>(pagePath('/resources', query)),
  createResource: (payload: Omit<ResourceRecord, 'id' | 'click_count'>) => api<{ success: true; id: string }>('/resources', { method: 'POST', body: JSON.stringify(payload) }),
  updateResource: (id: string, payload: Partial<ResourceRecord>) => api<{ success: true }>(`/resources/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteResource: (id: string) => api<{ success: true }>(`/resources/${id}`, { method: 'DELETE' }),
  jobs: (query: PageQuery = {}) => api<PageResult<JobReviewRecord>>(pagePath('/jobs', query)),
  reviewJob: (id: string, payload: { status: string; note: string }) => api<{ success: true }>(`/jobs/${id}/review`, { method: 'PUT', body: JSON.stringify(payload) }),
  refundJob: (id: string, note: string) => api<{ success: true; alreadyRefunded: boolean }>(`/jobs/${id}/refund`, { method: 'POST', body: JSON.stringify({ note }) }),
  sessions: (query: PageQuery = {}) => api<PageResult<SessionRecord> & { currentSessionId: string }>(pagePath('/sessions', query)),
  revokeSession: (id: string) => api<{ success: true; currentRevoked: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),
  setup2fa: (currentPassword: string) => api<{ success: true; secret: string; uri: string }>('/2fa/setup', { method: 'POST', body: JSON.stringify({ currentPassword }) }),
  enable2fa: (code: string) => api<{ success: true }>('/2fa/enable', { method: 'POST', body: JSON.stringify({ code }) }),
  disable2fa: (currentPassword: string, code: string) => api<{ success: true }>('/2fa', { method: 'DELETE', body: JSON.stringify({ currentPassword, code }) }),
  backups: (query: PageQuery = {}) => api<PageResult<BackupRecord>>(pagePath('/backups', query)),
  createBackup: (passphrase: string, reason = 'manual') => api<{ success: true; item: BackupRecord }>('/backups', { method: 'POST', body: JSON.stringify({ passphrase, reason }) }),
  previewBackup: (id: string, passphrase: string) => api<{ success: true; preview: Record<string, unknown> }>(`/backups/${id}/preview`, { method: 'POST', body: JSON.stringify({ passphrase }) }),
  restoreBackup: (id: string, passphrase: string) => api<{ success: true; message: string; preRestoreSnapshot: string }>(`/backups/${id}/restore`, { method: 'POST', body: JSON.stringify({ passphrase }) }),
  uploadBackup: (file: File) => api<{ success: true; id: string; filename: string }>('/backups/upload', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file }),
  updateStatus: () => api<{ success: true; state: UpdateState; adapterCatalogVersion: string; signingConfigured: boolean; applicationUpdateSupported: boolean; applicationUpdateHint: string }>('/update/status'),
  checkUpdate: () => api<{ success: true; state: UpdateState }>('/update/check', { method: 'POST', body: JSON.stringify({ channel: 'stable' }) }),
  prepareUpdate: () => api<{ success: true; state: UpdateState }>('/update/prepare', { method: 'POST', body: '{}' }),
  applyUpdate: () => api<{ success: true; state: UpdateState }>('/update/apply', { method: 'POST', body: '{}' }),
  updateAdapters: () => api<{ success: true; version: string; updated: number }>('/update/adapters', { method: 'POST', body: '{}' }),
  securityReport: () => api<{ success: true; report: SecurityReport }>('/security/report'),
};
