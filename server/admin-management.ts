import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Router, Request, RequestHandler } from 'express';
import type { PanelArkDatabase } from './panelark-db.js';
import type { PanelArkJobEngine } from './panelark-jobs.js';
import { backupFilePath } from './panelark-backup.js';
import { hashPassword, validatePassword, normalizeUsername } from './panelark-security.js';

type Context = { id: string; username: string; sessionId: string };
type Hooks = {
  permission: (name: string) => RequestHandler;
  actor: (req: Request) => Context;
  audit: (req: Request, action: string, type: string, id?: string, details?: unknown) => void;
  updateState: () => { phase: string; preUpdateBackup?: string };
};
const active = (status: unknown) => ['queued', 'running', 'cancelling'].includes(String(status));
const now = () => new Date().toISOString();
const string = (value: unknown, max = 1000) => String(value ?? '').trim().slice(0, max);
function required(value: unknown, max = 80) { const result = string(value, max); if (!result) throw new Error('请填写必填内容'); return result; }
function integer(value: unknown, min: number, max: number) { const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`请输入 ${min} 至 ${max} 的整数`); return n; }
const csv = (rows: unknown[][]) => '\uFEFF' + rows.map(row => row.map(value => { let s = String(value ?? ''); if (/^[\s]*[=+@-]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; }).join(',')).join('\r\n');

/** Mounted behind session + CSRF middleware. Destructive business operations are transactional. */
export function mountAdminManagement(router: Router, db: PanelArkDatabase, jobs: PanelArkJobEngine, dataDirectory: string, hooks: Hooks) {
  const { permission, actor, audit } = hooks;
  const route = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, perm: string, fn: RequestHandler) => {
    router[method](url, permission(perm), async (req, res, next) => {
      try { await fn(req, res, next); } catch (error) { res.status(409).json({ success: false, error: error instanceof Error ? error.message : String(error) }); }
    });
  };
  const exists = (table: string, id: string) => { const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]); if (!row) throw new Error('记录不存在，请刷新列表'); return row; };
  const idOf = (req: Request) => required(req.params.id);
  const recordAudit = (req: Request, action: string, type: string, id: string, details?: unknown) => audit(req, action, type, id, details);

  route('put', '/admin/packages/:id', 'cdk:write', (req, res) => {
    const id = idOf(req), old = exists('cdk_packages', id), b = req.body || {};
    const name = required(b.name ?? old.name), maxUses = integer(b.maxUses ?? old.max_uses, 1, 10000);
    const days = integer(b.validityDays ?? old.validity_days ?? 0, 0, 3650);
    const panel = string(b.allowedPanel ?? old.allowed_panel, 80), category = string(b.allowedCategory ?? old.allowed_category, 80);
    db.transaction(() => {
      if (db.get(`SELECT c.id FROM cdks c WHERE c.package_id = ? AND c.max_uses_override IS NULL AND
        c.used_count + (SELECT COUNT(*) FROM cdk_grants g WHERE g.cdk_id = c.id AND g.status = 'locked' AND g.expires_at > ?) > ? LIMIT 1`, [id, now(), maxUses])) throw new Error('次数不能低于已有 CDK 已用及锁定次数；请先处理关联 CDK');
      if ((panel !== String(old.allowed_panel || '') || category !== String(old.allowed_category || '')) && db.get(`SELECT g.id FROM cdk_grants g JOIN cdks c ON c.id = g.cdk_id WHERE c.package_id = ? AND g.status = 'locked' AND g.expires_at > ? LIMIT 1`, [id, now()])) throw new Error('关联任务正在使用此套餐，请任务结束后再修改授权范围');
      db.run('UPDATE cdk_packages SET name=?,description=?,max_uses=?,allowed_panel=?,allowed_category=?,validity_days=?,enabled=?,updated_at=? WHERE id=?', [name, string(b.description ?? old.description, 500), maxUses, panel || null, category || null, days || null, b.enabled === undefined ? old.enabled : b.enabled ? 1 : 0, now(), id]);
      recordAudit(req, 'cdk.package_edit', 'cdk_package', id, { name, maxUses, days, panel, category });
    });
    res.json({ success: true });
  });
  for (const kind of ['packages', 'batches'] as const) {
    route('delete', `/admin/${kind}/:id`, 'cdk:write', (req, res) => {
      const id = idOf(req), table = kind === 'packages' ? 'cdk_packages' : 'cdk_batches', column = kind === 'packages' ? 'package_id' : 'batch_id';
      const row = exists(table, id);
      const count = Number(db.get(`SELECT COUNT(*) total FROM cdks WHERE ${column} = ?`, [id])!.total);
      if (count && req.body?.cascadeCodes !== true) throw new Error(`包含 ${count} 个 CDK，必须明确确认连同 CDK 一起删除`);
      db.transaction(() => {
        if (db.get(`SELECT g.id FROM cdk_grants g JOIN cdks c ON c.id=g.cdk_id WHERE c.${column}=? AND (g.status='locked' OR EXISTS (SELECT 1 FROM deployment_jobs j WHERE j.task_key=g.task_key AND j.status IN ('queued','running','cancelling'))) LIMIT 1`, [id])) throw new Error('包含正在执行或锁定的 CDK，请先取消任务并等待结束');
        db.run(`DELETE FROM cdks WHERE ${column}=?`, [id]);
        if (kind === 'packages') db.run('DELETE FROM cdk_batches WHERE package_id=?', [id]);
        db.run(`DELETE FROM ${table} WHERE id=?`, [id]);
        recordAudit(req, `cdk.${kind}_delete`, table, id, { name: row.name, deletedCodes: count });
      });
      res.json({ success: true, affected: count });
    });
  }
  route('patch', '/admin/batches/:id', 'cdk:write', (req, res) => {
    const id = idOf(req); exists('cdk_batches', id); const name = required(req.body?.name);
    db.transaction(() => { db.run('UPDATE cdk_batches SET name=? WHERE id=?', [name, id]); recordAudit(req, 'cdk.batch_rename', 'cdk_batch', id, { name }); });
    res.json({ success: true });
  });

  route('put', '/admin/admins/:id', '*', (req, res) => {
    const id = idOf(req), old = exists('admins', id), username = normalizeUsername(req.body?.username ?? old.username), role = req.body?.role ?? old.role;
    const enabled = req.body?.enabled === undefined ? Number(old.enabled) : req.body.enabled ? 1 : 0;
    if (!['super_admin', 'operator', 'support'].includes(role)) throw new Error('管理员角色无效');
    if (id === actor(req).id && (role !== 'super_admin' || !enabled)) throw new Error('不能停用或降权当前超级管理员，请使用另一超级管理员账号操作');
    db.transaction(() => { db.run('UPDATE admins SET username=?,role=?,enabled=?,updated_at=? WHERE id=?', [username, role, enabled, now(), id]); if (!enabled) db.run('DELETE FROM admin_sessions WHERE admin_id=?', [id]); recordAudit(req, 'admin.edit', 'admin', id, { username, role, enabled }); });
    res.json({ success: true });
  });
  route('post', '/admin/admins/:id/password', '*', async (req, res) => {
    const id = idOf(req); exists('admins', id); const hashed = await hashPassword(validatePassword(req.body?.password));
    // Recheck authorization after hashing: another request may have revoked this actor.
    const owner = db.get('SELECT role,enabled FROM admins WHERE id=?', [actor(req).id]);
    if (!owner || owner.role !== 'super_admin' || Number(owner.enabled) !== 1 || !db.get('SELECT id FROM admin_sessions WHERE id=?', [actor(req).sessionId])) throw new Error('管理权限已变更，请重新登录');
    exists('admins', id);
    db.transaction(() => { db.run('UPDATE admins SET password_hash=?,password_changed_at=?,updated_at=? WHERE id=?', [hashed, now(), now(), id]); db.run('DELETE FROM admin_sessions WHERE admin_id=? AND id<>?', [id, id === actor(req).id ? actor(req).sessionId : '']); recordAudit(req, 'admin.password_reset', 'admin', id); });
    res.json({ success: true });
  });
  route('post', '/admin/admins/:id/reset-2fa', '*', (req, res) => {
    const id = idOf(req); exists('admins', id);
    db.transaction(() => { db.run('UPDATE admins SET totp_enabled=0,totp_secret=NULL,updated_at=? WHERE id=?', [now(), id]); db.run('DELETE FROM admin_sessions WHERE admin_id=? AND id<>?', [id, id === actor(req).id ? actor(req).sessionId : '']); recordAudit(req, 'admin.2fa_reset', 'admin', id); }); res.json({ success: true });
  });
  route('delete', '/admin/admins/:id/sessions', '*', (req, res) => {
    const id = idOf(req); exists('admins', id); db.transaction(() => { db.run('DELETE FROM admin_sessions WHERE admin_id=? AND id<>?', [id, id === actor(req).id ? actor(req).sessionId : '']); recordAudit(req, 'admin.sessions_revoke', 'admin', id); }); res.json({ success: true });
  });
  route('delete', '/admin/admins/:id', '*', (req, res) => {
    const id = idOf(req), old = exists('admins', id);
    if (id === actor(req).id) throw new Error('不能删除当前登录账号，请使用另一超级管理员账号操作');
    db.transaction(() => {
      db.run('UPDATE audit_logs SET actor_name=COALESCE(actor_name,?),admin_id=NULL WHERE admin_id=?', [old.username, id]);
      for (const [table, column] of [['cdk_batches', 'created_by'], ['catalog_overrides', 'updated_by'], ['job_reviews', 'reviewed_by'], ['backup_records', 'created_by']]) db.run(`UPDATE ${table} SET ${column}=NULL WHERE ${column}=?`, [id]);
      db.run('DELETE FROM admins WHERE id=?', [id]); recordAudit(req, 'admin.delete', 'admin', id, { username: old.username, role: old.role });
    }); res.json({ success: true });
  });
  route('delete', '/admin/catalog/:id', 'catalog:write', (req, res) => {
    const id = idOf(req); db.transaction(() => { db.run('DELETE FROM catalog_overrides WHERE adapter_id=?', [id]); recordAudit(req, 'catalog.reset', 'adapter', id); }); res.json({ success: true });
  });

  route('get', '/admin/jobs/export', 'jobs:read', (_req, res) => {
    const rows = db.all(`SELECT j.id,j.kind,j.status,j.error_message,j.created_at,r.status review_status,r.refund_status,r.note FROM deployment_jobs j LEFT JOIN job_reviews r ON r.job_id=j.id ORDER BY j.created_at DESC,j.id`);
    res.set('Cache-Control', 'no-store').json({ success: true, filename: 'panelark-jobs.csv', content: csv([['任务ID','类型','执行状态','失败原因','创建时间','售后状态','返还状态','处理备注'], ...rows.map(r => [r.id,r.kind,r.status,r.error_message,r.created_at,r.review_status,r.refund_status,r.note])]) });
  });
  route('get', '/admin/jobs/:id', 'jobs:read', (req, res) => {
    const id = idOf(req), job = jobs.getJob(id); if (!job) throw new Error('部署任务不存在');
    const task = exists('deployment_jobs', id).task_key;
    const grant = task ? db.get(`SELECT g.status,c.code_hint,c.used_count,COALESCE(c.max_uses_override,p.max_uses) max_uses FROM cdk_grants g JOIN cdks c ON c.id=g.cdk_id JOIN cdk_packages p ON p.id=c.package_id WHERE g.task_key=?`, [task]) : undefined;
    res.set('Cache-Control', 'no-store').json({ success: true, job, events: jobs.getEvents(id), review: db.get('SELECT * FROM job_reviews WHERE job_id=?', [id]) || null, notes: db.all('SELECT n.*,a.username FROM job_notes n LEFT JOIN admins a ON a.id=n.created_by WHERE n.job_id=? ORDER BY n.created_at,n.id', [id]), grant: grant || null });
  });
  route('post', '/admin/jobs/:id/cancel', 'jobs:cancel', (req, res) => {
    const id = idOf(req), row = exists('deployment_jobs', id);
    const job = jobs.cancelJob(id);
    if (row.status === 'queued' && row.task_key) db.run("UPDATE cdk_grants SET status='released',released_at=? WHERE task_key=? AND status='locked'", [now(), row.task_key]);
    recordAudit(req, 'job.cancel', 'deployment_job', id, { status: job.status });
    res.json({ success: true, job });
  });
  route('delete', '/admin/jobs/:id', '*', (req, res) => {
    const id = idOf(req), row = exists('deployment_jobs', id);
    if (active(row.status) || db.get('SELECT job_id FROM deployment_locks WHERE job_id=?', [id])) throw new Error('请先取消任务并等待安全停止，再删除记录');
    if (req.body?.confirm !== 'DELETE') throw new Error('请确认删除任务记录；此操作不卸载服务器项目，也不自动返还 CDK');
    db.transaction(() => { const review = db.get('SELECT * FROM job_reviews WHERE job_id=?', [id]); db.run('DELETE FROM deployment_jobs WHERE id=?', [id]); recordAudit(req, 'job.delete', 'deployment_job', id, { status: row.status, taskKey: row.task_key, review }); }); res.json({ success: true });
  });
  route('delete', '/admin/jobs/:id/review', 'jobs:review', (req, res) => {
    const id = idOf(req); exists('deployment_jobs', id);
    db.transaction(() => { const old = db.get('SELECT * FROM job_reviews WHERE job_id=?', [id]); db.run('DELETE FROM job_reviews WHERE job_id=?', [id]); recordAudit(req, 'job.review_delete', 'deployment_job', id, { previous: old }); }); res.json({ success: true });
  });
  route('post', '/admin/jobs/:id/notes', 'jobs:review', (req, res) => {
    const jobId = idOf(req); exists('deployment_jobs', jobId); const id = randomUUID(), note = required(req.body?.note, 2000);
    db.transaction(() => { db.run('INSERT INTO job_notes(id,job_id,note,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)', [id, jobId, note, actor(req).id, now(), now()]); recordAudit(req, 'job.note_create', 'deployment_job', jobId, { noteId: id, note }); }); res.json({ success: true, id });
  });
  for (const method of ['put', 'delete'] as const) route(method, '/admin/jobs/:id/notes/:noteId', 'jobs:review', (req, res) => {
    const jobId = idOf(req), id = required(req.params.noteId), old = db.get('SELECT * FROM job_notes WHERE id=? AND job_id=?', [id, jobId]); if (!old) throw new Error('处理记录不存在');
    db.transaction(() => { if (method === 'put') db.run('UPDATE job_notes SET note=?,updated_at=? WHERE id=?', [required(req.body?.note, 2000), now(), id]); else db.run('DELETE FROM job_notes WHERE id=?', [id]); recordAudit(req, `job.note_${method === 'put' ? 'edit' : 'delete'}`, 'deployment_job', jobId, { noteId: id, previous: old.note, note: method === 'put' ? string(req.body?.note, 2000) : undefined }); }); res.json({ success: true });
  });

  route('patch', '/admin/backups/:id', '*', (req, res) => { const id = idOf(req); exists('backup_records', id); const label = string(req.body?.label, 80); db.transaction(() => { db.run('UPDATE backup_records SET label=? WHERE id=?', [label, id]); recordAudit(req, 'backup.label', 'backup', id, { label }); }); res.json({ success: true }); });
  route('delete', '/admin/backups/:id', '*', (req, res) => {
    const id = idOf(req), record = exists('backup_records', id), state = hooks.updateState();
    if (['downloading','prepared','applying','restarting'].includes(state.phase) && state.preUpdateBackup === record.filename) throw new Error('此备份正在用于更新保护，更新结束后可删除');
    const source = backupFilePath(dataDirectory, String(record.filename)), trash = path.join(dataDirectory, 'backups', '.trash');
    fs.mkdirSync(trash, { recursive: true }); const target = path.join(trash, `${randomUUID()}-${path.basename(source)}`), moved = fs.existsSync(source);
    if (moved) fs.renameSync(source, target);
    try { db.transaction(() => { db.run('DELETE FROM backup_records WHERE id=?', [id]); recordAudit(req, 'backup.delete', 'backup', id, { filename: record.filename, recoverable: moved }); }); } catch (error) { if (moved) fs.renameSync(target, source); throw error; }
    res.json({ success: true, message: moved ? '备份已移入数据目录 backups/.trash，可由服务器管理员恢复' : '备份文件已不存在，列表记录已清理' });
  });
  route('get', '/admin/audit/export', 'audit:read', (_req, res) => {
    const rows = db.all('SELECT l.*,COALESCE(l.actor_name,a.username) username FROM audit_logs l LEFT JOIN admins a ON a.id=l.admin_id ORDER BY l.id DESC');
    res.set('Cache-Control','no-store').json({ success: true, filename: 'panelark-audit.csv', content: csv([['时间','管理员','操作','目标类型','目标ID','IP','详情'], ...rows.map(r => [r.created_at,r.username,r.action,r.target_type,r.target_id,r.ip,r.details])]) });
  });
  route('delete', '/admin/audit', '*', (req, res) => {
    const timestamp = Date.parse(req.body?.before), before = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
    if (!before || timestamp > Date.now() || req.body?.confirm !== 'DELETE') throw new Error('请选择过去的截止时间并明确确认清理');
    const count = Number(db.get('SELECT COUNT(*) total FROM audit_logs WHERE created_at<?', [before])!.total);
    db.transaction(() => { db.run('DELETE FROM audit_logs WHERE created_at<?', [before]); recordAudit(req, 'audit.cleanup', 'audit_logs', before, { deleted: count }); }); res.json({ success: true, affected: count });
  });
}
