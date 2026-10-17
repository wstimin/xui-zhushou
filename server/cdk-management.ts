import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { Request, RequestHandler, Response, Router } from 'express';
import type { PanelArkDatabase, DbRow } from './panelark-db.js';
import { pagedSql } from './pagination.js';
import { hashCdk, normalizeCdk, safeEqualString } from './panelark-security.js';

function encryptionKey(pepper: Buffer) {
  return createHmac('sha256', pepper).update('PanelArk/CDK/encryption/v1').digest();
}

export function encryptCdkCode(code: string, pepper: Buffer, id: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(pepper), iv);
  cipher.setAAD(Buffer.from(id));
  const encrypted = Buffer.concat([cipher.update(normalizeCdk(code), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptCdkCode(row: DbRow, pepper: Buffer) {
  if (!row.code_encrypted) return null; // Pre-upgrade hashes cannot be reversed.
  try {
    const [version, iv, tag, value, extra] = String(row.code_encrypted).split('.');
    if (version !== 'v1' || !iv || !tag || !value || extra) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(pepper), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(String(row.id)));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const code = Buffer.concat([decipher.update(Buffer.from(value, 'base64url')), decipher.final()]).toString('utf8');
    if (!safeEqualString(hashCdk(code, pepper), String(row.code_hash))) throw new Error();
    return code;
  } catch { throw new Error('CDK 解密失败，请检查备份中的业务密钥是否一致'); }
}

const statuses = ['active', 'disabled', 'refunded'];
const columns = `c.id, c.batch_id, c.package_id, c.code_hint, c.used_count, c.status, c.expires_at, c.created_at,
  p.name AS package_name, COALESCE(c.max_uses_override, p.max_uses) AS max_uses,
  b.name AS batch_name, CASE WHEN c.code_encrypted IS NULL THEN 0 ELSE 1 END AS code_available,
  (SELECT COUNT(*) FROM cdk_grants g WHERE g.cdk_id = c.id AND g.status = 'locked' AND julianday(g.expires_at) > julianday('now')) AS locked_count`;
const joins = 'FROM cdks c JOIN cdk_packages p ON p.id = c.package_id LEFT JOIN cdk_batches b ON b.id = c.batch_id';

function filters(input: Record<string, unknown>, pepper: Buffer) {
  const conditions: string[] = [], params: string[] = [];
  for (const key of ['status', 'packageId', 'batchId', 'search']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error('筛选参数无效');
  }
  if (input.status && !statuses.includes(String(input.status))) throw new Error('筛选状态无效');
  for (const [key, column] of [['packageId', 'c.package_id'], ['batchId', 'c.batch_id']] as const) {
    if (input[key]) { conditions.push(`${column} = ?`); params.push(String(input[key]).slice(0, 80)); }
  }
  if (statuses.includes(String(input.status))) { conditions.push('c.status = ?'); params.push(String(input.status)); }
  const search = typeof input.search === 'string' ? input.search.trim().slice(0, 200) : '';
  if (search) {
    conditions.push("(c.code_hash = ? OR c.code_hint LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR b.name LIKE ? ESCAPE '\\')");
    const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(hashCdk(search, pepper), like, like, like);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params };
}

function selection(db: PanelArkDatabase, input: Record<string, any>, pepper: Buffer) {
  const filter = filters(input.filters || {}, pepper);
  if (input.ids !== undefined) {
    if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 500 || input.ids.some((id: unknown) => typeof id !== 'string' || !id || id.length > 80)) throw new Error('请选择 1 至 500 个 CDK');
    const ids = [...new Set<string>(input.ids)];
    const rows = db.all(`SELECT c.*, p.name AS package_name, b.name AS batch_name, COALESCE(c.max_uses_override, p.max_uses) AS max_uses ${joins} WHERE c.id IN (${ids.map(() => '?').join(',')}) ORDER BY c.created_at DESC, c.id`, ids);
    if (rows.length !== ids.length) throw new Error('部分 CDK 已不存在，请刷新列表');
    return rows;
  }
  if (input.scope !== 'filtered') throw new Error('请明确选择 CDK 或当前筛选范围');
  return db.all(`SELECT c.*, p.name AS package_name, b.name AS batch_name, COALESCE(c.max_uses_override, p.max_uses) AS max_uses ${joins} ${filter.where} ORDER BY c.created_at DESC, c.id`, filter.params);
}

function csvCell(value: unknown) {
  let text = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function mountCdkManagement(router: Router, db: PanelArkDatabase, currentPepper: () => Buffer, options: {
  permission: (permission: string) => RequestHandler;
  audit: (req: Request, action: string, target: string | undefined, details: unknown) => void;
}) {
  const { permission, audit } = options;
  const failure = (res: Response, error: unknown, status = 400) => res.status(status).json({ success: false, error: error instanceof Error ? error.message : '操作失败' });
  const assertUnlocked = (rows: DbRow[]) => {
    for (const row of rows) {
      if (db.get("SELECT id FROM cdk_grants WHERE cdk_id = ? AND status = 'locked' AND expires_at > ?", [row.id, new Date().toISOString()])) throw new Error('CDK 正在被部署任务占用，请先完成或结束任务后再修改或删除');
    }
  };
  const remove = (req: Request, input: Record<string, any>) => {
    const rows = selection(db, input, currentPepper());
    db.transaction(() => {
      assertUnlocked(rows);
      for (const row of rows) db.run('DELETE FROM cdks WHERE id = ?', [row.id]);
      audit(req, 'cdk.delete', undefined, { ids: rows.map(row => row.id), count: rows.length });
    });
    return rows.length;
  };

  router.get('/admin/cdks', permission('cdk:read'), (req, res) => {
    try {
      const { where, params } = filters(req.query, currentPepper());
      res.set('Cache-Control', 'no-store').json({ success: true, ...pagedSql(db, req, `SELECT ${columns} ${joins} ${where} ORDER BY c.created_at DESC, c.id`, `SELECT COUNT(*) AS total ${joins} ${where}`, params) });
    } catch (error) { failure(res, error); }
  });
  router.get('/admin/batches', permission('cdk:read'), (req, res) => {
    res.json({ success: true, ...pagedSql(db, req, `SELECT b.id, b.name, b.quantity, b.package_id, b.created_at, p.name AS package_name FROM cdk_batches b JOIN cdk_packages p ON p.id = b.package_id ORDER BY b.created_at DESC, b.id`, 'SELECT COUNT(*) AS total FROM cdk_batches') });
  });
  router.post('/admin/cdks/export', permission('cdk:export'), (req, res) => {
    try {
      const pepper = currentPepper();
      const rows = selection(db, req.body || {}, pepper);
      if (!rows.length) throw new Error('所选范围没有 CDK');
      const entries = rows.map(row => ({ row, code: decryptCdkCode(row, pepper) }));
      const available = entries.filter(item => item.code !== null);
      const format = req.body?.format === 'csv' ? 'csv' : 'txt';
      if (format === 'txt' && !available.length) throw new Error('所选 CDK 均为旧版哈希记录，无法还原明文；可导出 CSV 管理记录');
      const content = format === 'txt' ? available.map(item => item.code).join('\n') + '\n'
        : '\uFEFF' + [['CDK', '标识', '套餐', '批次', '状态', '已用次数', '总次数', '有效期', '创建时间', '明文可读取'], ...entries.map(({ row, code }) => [code || '', row.code_hint, row.package_name, row.batch_name, row.status, row.used_count, row.max_uses, row.expires_at || '', row.created_at, code ? '是' : '旧版哈希不可还原'])].map(line => line.map(csvCell).join(',')).join('\r\n');
      audit(req, 'cdk.export', undefined, { count: rows.length, exported: available.length, format });
      res.set('Cache-Control', 'no-store').json({ success: true, filename: `panelark-cdks-${new Date().toISOString().slice(0, 10)}.${format}`, mime: format === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8', content, total: rows.length, exported: available.length, unavailable: rows.length - available.length });
    } catch (error) { failure(res, error); }
  });
  router.post('/admin/cdks/bulk', permission('cdk:write'), (req, res) => {
    try {
      if (req.body?.action === 'delete') {
        return res.json({ success: true, affected: remove(req, req.body) });
      }
      const status = String(req.body?.status || '');
      if (req.body?.action !== 'status' || !statuses.includes(status)) throw new Error('批量操作无效');
      const rows = selection(db, req.body, currentPepper());
      db.transaction(() => {
        assertUnlocked(rows);
        for (const row of rows) {
          db.run('UPDATE cdks SET status = ?, updated_at = ? WHERE id = ?', [status, new Date().toISOString(), row.id]);
          if (status !== 'active') db.run("UPDATE cdk_grants SET status = 'released', released_at = ? WHERE cdk_id = ? AND status = 'validated'", [new Date().toISOString(), row.id]);
        }
        audit(req, 'cdk.bulk_status', undefined, { count: rows.length, status });
      });
      res.json({ success: true, affected: rows.length });
    } catch (error) { failure(res, error, 409); }
  });
  router.post('/admin/cdks/:id/reveal', permission('cdk:export'), (req, res) => {
    try {
      const row = db.get('SELECT * FROM cdks WHERE id = ?', [String(req.params.id)]);
      if (!row) throw new Error('CDK 不存在');
      const code = decryptCdkCode(row, currentPepper());
      if (!code) throw new Error('此 CDK 为旧版哈希记录，无法还原明文；可在编辑中重新绑定你保存的原始 CDK');
      audit(req, 'cdk.reveal', String(row.id), {});
      res.set('Cache-Control', 'no-store').json({ success: true, code });
    } catch (error) { failure(res, error); }
  });
  router.patch('/admin/cdks/:id', permission('cdk:write'), (req, res) => {
    try {
      const pepper = currentPepper();
      const row = db.get('SELECT * FROM cdks WHERE id = ?', [String(req.params.id)]);
      if (!row) throw new Error('CDK 不存在');
      const status = req.body?.status ?? row.status;
      if (!statuses.includes(status)) throw new Error('CDK 状态无效');
      const used = req.body?.usedCount ?? Number(row.used_count);
      const maxUses = req.body?.maxUses ?? (row.max_uses_override === null ? null : Number(row.max_uses_override));
      if (!Number.isSafeInteger(used) || used < 0 || (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 10000))) throw new Error('使用次数必须为有效整数，总次数需为 1 至 10000');
      const packageRow = db.get('SELECT max_uses FROM cdk_packages WHERE id = ?', [row.package_id])!;
      if (used > Number(maxUses ?? packageRow.max_uses)) throw new Error('已用次数不能大于总次数');
      let expiresAt = row.expires_at;
      if (req.body?.expiresAt !== undefined) {
        const date = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
        if (date && !Number.isFinite(date.getTime())) throw new Error('有效期不是有效日期');
        expiresAt = date ? date.toISOString() : null;
      }
      let encrypted = row.code_encrypted;
      if (req.body?.originalCode) {
        const code = normalizeCdk(req.body.originalCode);
        if (!safeEqualString(hashCdk(code, pepper), String(row.code_hash))) throw new Error('原始 CDK 与此记录不匹配，未修改');
        encrypted = encryptCdkCode(code, pepper, String(row.id));
      }
      db.transaction(() => {
        assertUnlocked([row]);
        db.run('UPDATE cdks SET status = ?, used_count = ?, max_uses_override = ?, expires_at = ?, code_encrypted = ?, updated_at = ? WHERE id = ?', [status, used, maxUses, expiresAt, encrypted, new Date().toISOString(), row.id]);
        if (status !== 'active') db.run("UPDATE cdk_grants SET status = 'released', released_at = ? WHERE cdk_id = ? AND status = 'validated'", [new Date().toISOString(), row.id]);
        audit(req, 'cdk.update', String(row.id), { status, usedCount: used, maxUses, expiresAt, originalCodeBound: Boolean(req.body?.originalCode) });
      });
      res.json({ success: true });
    } catch (error) { failure(res, error, 409); }
  });
  router.delete('/admin/cdks/:id', permission('cdk:write'), (req, res) => {
    try { res.json({ success: true, affected: remove(req, { ids: [String(req.params.id)] }) }); }
    catch (error) { failure(res, error, 409); }
  });
}
