import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { mountPanelArkApi } from './panelark-api.js';
import { PanelArkDatabase } from './panelark-db.js';

test('complete admin management: real HTTP CRUD, roles, atomicity, refunds, session revocation and persistence', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panelark-management-'));
  const keys = ['PANELARK_DATA_DIR', 'PANELARK_DEPLOYMENT_MODE', 'PANELARK_SETUP_TOKEN', 'PANELARK_BACKUP_PASSPHRASE'] as const;
  const saved = keys.map(key => process.env[key]);
  process.env.PANELARK_DATA_DIR = directory; process.env.PANELARK_DEPLOYMENT_MODE = 'panel'; process.env.PANELARK_SETUP_TOKEN = 'test-setup-token'; process.env.PANELARK_BACKUP_PASSPHRASE = 'backup-test-password';
  const app = express(); app.use(express.json()); const services = await mountPanelArkApi(app), { db, jobEngine } = services;
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const request = async (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json() as any; return { status: response.status, json, response };
  };
  const boot = await request('/admin/bootstrap', 'POST', { setupToken: 'test-setup-token', username: 'owner', password: '123456' });
  const owner = { cookie: boot.response.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': boot.json.csrfToken };
  const admin = async (route: string, method = 'GET', body?: unknown, status = 200) => { const r = await request('/admin' + route, method, body, owner); assert.equal(r.status, status, `${method} ${route}: ${JSON.stringify(r.json)}`); return r.json; };
  const login = async (username: string, password = '123456') => { const r = await request('/admin/login', 'POST', { username, password }); assert.equal(r.status, 200, JSON.stringify(r.json)); return { cookie: r.response.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': r.json.csrfToken }; };
  let operator: Record<string, string>, support: Record<string, string>, operatorId: string, pkg: string, batch: string, code: string, cdkId: string, jobId: string, backupId: string;
  try {
    await t.test('super admin can create/edit accounts and all roles are enforced server-side, including CSRF', async () => {
      operatorId = (await admin('/admins', 'POST', { username: 'operator', password: '123456', role: 'operator' })).id;
      await admin('/admins', 'POST', { username: 'support', password: '123456', role: 'support' });
      operator = await login('operator'); support = await login('support');
      for (const [route, method, body] of [
        ['/admins', 'POST', { username: 'intruder', password: '123456', role: 'super_admin' }],
        [`/admins/${operatorId}`, 'DELETE', undefined],
        [`/admins/${operatorId}/password`, 'POST', { password: '654321' }],
        ['/backups', 'POST', { passphrase: '123456' }],
        ['/audit', 'DELETE', { before: new Date().toISOString(), confirm: 'DELETE' }],
        ['/update/check', 'POST', { channel: 'stable' }],
      ] as const) for (const headers of [operator, support]) assert.equal((await request('/admin' + route, method, body, headers)).status, 403);
      assert.equal((await request(`/admin/admins/${operatorId}`, 'PUT', { username: 'changed' }, { cookie: owner.cookie })).status, 403);
      await admin(`/admins/${boot.json.admin.id}`, 'DELETE', undefined, 409);
      await admin(`/admins/${boot.json.admin.id}`, 'PUT', { role: 'support' }, 409);
      await admin(`/admins/${operatorId}`, 'PUT', { username: 'operator-renamed', role: 'operator', enabled: true });
      assert.equal(db.get('SELECT username FROM admins WHERE id=?', [operatorId])!.username, 'operator-renamed');
      await admin(`/admins/${operatorId}`, 'PUT', { username: 'owner' }, 409);
      assert.equal(db.get('SELECT username FROM admins WHERE id=?', [operatorId])!.username, 'operator-renamed');
    });
    await t.test('package full edits affect live CDK entitlements, batch rename works, unsafe quotas roll back', async () => {
      pkg = (await admin('/packages', 'POST', { name: '测试套餐', maxUses: 5, validityDays: 10 })).id;
      const b = await admin('/batches', 'POST', { packageId: pkg, quantity: 2, name: '测试批次' }); batch = b.batchId; code = b.codes[0];
      cdkId = db.get('SELECT id FROM cdks WHERE batch_id=? ORDER BY id', [batch])!.id as string;
      await admin(`/packages/${pkg}`, 'PUT', { name: '修改后', description: '完整资料', maxUses: 7, validityDays: 0, allowedPanel: '', allowedCategory: '', enabled: true });
      const row = db.get('SELECT * FROM cdk_packages WHERE id=?', [pkg])!; assert.equal(row.name, '修改后'); assert.equal(row.validity_days, null); assert.equal(row.max_uses, 7);
      const valid = await request('/cdk/validate', 'POST', { code }); assert.equal(valid.json.remaining, 7);
      await admin(`/batches/${batch}`, 'PATCH', { name: '批次已重命名' }); assert.equal(db.get('SELECT name FROM cdk_batches WHERE id=?', [batch])!.name, '批次已重命名');
      db.run('UPDATE cdks SET used_count=3 WHERE id=?', [cdkId]);
      await admin(`/packages/${pkg}`, 'PUT', { name: '不得写入', maxUses: 2 }, 409); assert.equal(db.get('SELECT name FROM cdk_packages WHERE id=?', [pkg])!.name, '修改后');
      await admin(`/packages/${pkg}`, 'PUT', { maxUses: 5.5 }, 409);
      assert.equal((await request(`/admin/packages/${pkg}`, 'PUT', { name: '禁止' }, support)).status, 403);
      await admin(`/packages/${pkg}`, 'PATCH', { enabled: false }); await admin('/batches', 'POST', { packageId: pkg, quantity: 1 }, 400); await admin(`/packages/${pkg}`, 'PATCH', { enabled: true });
    });
    await t.test('recommendations persist every field including sort zero, invalid links do not save', async () => {
      const resource = await admin('/resources', 'POST', { type: 'vps', title: '推荐', description: '说明', badge: '标签', url: 'https://example.test', sort_order: 0, enabled: 1 }, 201);
      assert.equal(db.get('SELECT sort_order FROM recommended_resources WHERE id=?', [resource.id])!.sort_order, 0);
      await admin(`/resources/${resource.id}`, 'PUT', { type: 'domain', title: '新标题', description: '新说明', badge: '新标签', url: 'https://new.example.test', sort_order: 3, enabled: 0 });
      const row = db.get('SELECT * FROM recommended_resources WHERE id=?', [resource.id])!; assert.equal(row.type, 'domain'); assert.equal(row.description, '新说明'); assert.equal(row.badge, '新标签'); assert.equal(row.sort_order, 3); assert.equal(row.enabled, 0);
      for (const input of [{ title: '' }, { url: 'https://user:pass@example.test' }, { sort_order: 1.5 }]) assert.notEqual((await request(`/admin/resources/${resource.id}`, 'PUT', input, owner)).status, 200);
      assert.equal((await request(`/admin/resources/${resource.id}`, 'DELETE', undefined, support)).status, 403);
      await admin(`/resources/${resource.id}`, 'DELETE'); await admin(`/resources/${resource.id}`, 'DELETE', undefined, 404);
    });
    await t.test('catalog partial updates preserve metadata and reset clears the actual override', async () => {
      const catalog = await admin('/catalog'); const item = catalog.items[0];
      await admin(`/catalog/${item.id}`, 'PUT', { name: '自定义项目', category: '建站', description: '介绍', sortOrder: 0, enabled: true });
      await admin(`/catalog/${item.id}`, 'PUT', { enabled: false });
      const saved = db.get('SELECT * FROM catalog_overrides WHERE adapter_id=?', [item.id])!; assert.equal(saved.name, '自定义项目'); assert.equal(saved.sort_order, 0); assert.equal(saved.enabled, 0);
      assert.notEqual((await request(`/admin/catalog/${item.id}`, 'PUT', { sortOrder: 'NaN' }, owner)).status, 200);
      await admin(`/catalog/${item.id}`, 'DELETE'); assert.equal(db.get('SELECT * FROM catalog_overrides WHERE adapter_id=?', [item.id]), undefined);
    });
    await t.test('task detail and after-sales notes support real creation, editing, deletion and review states', async () => {
      const job = jobEngine.createJob({ kind: 'test-admin', serverKey: 'test-server', taskKey: 'refund-test', steps: [{ key: 'check', title: '环境检测' }], payload: { password: 'never-expose' } }); jobId = job.id;
      db.run("UPDATE deployment_jobs SET status='failed',error_message='依赖下载失败' WHERE id=?", [jobId]);
      const detail = await admin(`/jobs/${jobId}`); assert.equal(detail.job.errorMessage, '依赖下载失败'); assert.equal(detail.job.steps.length, 1); assert.doesNotMatch(JSON.stringify(detail), /never-expose/);
      assert.equal((await admin('/jobs?search=test-server&status=failed&reviewStatus=pending')).pagination.total, 1);
      assert.equal((await admin('/jobs?search=%25')).pagination.total, 0);
      const note = await admin(`/jobs/${jobId}/notes`, 'POST', { note: '首次排查' });
      await admin(`/jobs/${jobId}/notes/${note.id}`, 'PUT', { note: '已核实网络失败' });
      assert.equal((await admin(`/jobs/${jobId}`)).notes[0].note, '已核实网络失败');
      for (const status of ['pending','reviewed','resolved']) { const r = await request(`/admin/jobs/${jobId}/review`, 'PUT', { status, note: '售后记录' }, support); assert.equal(r.status, 200); assert.equal((await admin(`/jobs/${jobId}`)).review.status, status); }
      await admin(`/jobs/${jobId}/notes/${note.id}`, 'DELETE'); assert.equal((await admin(`/jobs/${jobId}`)).notes.length, 0);
      await admin(`/jobs/${jobId}/notes/${note.id}`, 'DELETE', undefined, 409);
      await admin(`/jobs/${jobId}/notes`, 'POST', { note: '持久化处理记录' });
    });
    await t.test('refund cannot race a running deployment; removing a review never refunds twice', async () => {
      db.run("INSERT INTO cdk_grants(id,cdk_id,token_hash,task_key,status,created_at,expires_at) VALUES ('refund-grant',?,'test-refund-token','refund-test','consumed',?,?)", [cdkId, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString()]);
      db.run('UPDATE cdks SET used_count=3 WHERE id=?', [cdkId]);
      db.run("UPDATE deployment_jobs SET status='running' WHERE id=?", [jobId]);
      await admin(`/jobs/${jobId}/refund`, 'POST', { note: '不能提前返还' }, 409); assert.equal(db.get('SELECT used_count FROM cdks WHERE id=?', [cdkId])!.used_count, 3);
      await admin(`/cdks/${cdkId}`, 'DELETE', undefined, 409);
      await admin(`/jobs/${jobId}`, 'DELETE', { confirm: 'DELETE' }, 409);
      assert.equal((await request(`/admin/jobs/${jobId}/cancel`, 'POST', {}, support)).status, 403);
      db.run("UPDATE deployment_jobs SET status='failed' WHERE id=?", [jobId]);
      assert.equal((await admin(`/jobs/${jobId}/refund`, 'POST', { note: '下载失败返还' })).alreadyRefunded, false);
      assert.equal(db.get('SELECT used_count FROM cdks WHERE id=?', [cdkId])!.used_count, 2);
      await admin(`/jobs/${jobId}/review`, 'DELETE');
      assert.equal((await admin(`/jobs/${jobId}/refund`, 'POST', { note: '不能重复返还' })).alreadyRefunded, true);
      assert.equal(db.get('SELECT used_count FROM cdks WHERE id=?', [cdkId])!.used_count, 2);
      assert.match((await admin('/jobs/export')).content, /下载失败|售后|不能重复返还/);
    });
    await t.test('queued tasks cancel safely and final record deletion is super-admin only', async () => {
      const job = jobEngine.createJob({ kind: 'test-queued', serverKey: 'queue', steps: [{ key: 'check', title: '检查' }] });
      assert.equal((await request(`/admin/jobs/${job.id}/cancel`, 'POST', {}, operator)).status, 200);
      assert.equal(jobEngine.getJob(job.id)!.status, 'cancelled');
      assert.equal((await request(`/admin/jobs/${job.id}`, 'DELETE', { confirm: 'DELETE' }, operator)).status, 403);
      await admin(`/jobs/${job.id}`, 'DELETE', {}, 409); await admin(`/jobs/${job.id}`, 'DELETE', { confirm: 'DELETE' }); assert.equal(jobEngine.getJob(job.id), undefined);
    });
    await t.test('backups support labels, schedule save and recoverable deletion', async () => {
      const b = await admin('/backups', 'POST', { passphrase: '123456' }, 201); backupId = b.item.id;
      await admin(`/backups/${backupId}`, 'PATCH', { label: '整改验收快照' }); assert.equal(db.get('SELECT label FROM backup_records WHERE id=?', [backupId])!.label, '整改验收快照');
      await admin('/backup-schedule', 'PUT', { enabled: true }); assert.equal((await admin('/backup-schedule')).enabled, true);
      await admin('/backup-schedule', 'PUT', { enabled: false });
      const copy = await admin('/backups', 'POST', { passphrase: '123456' }, 201);
      await admin(`/backups/${copy.item.id}`, 'DELETE'); assert.ok(!fs.existsSync(path.join(directory, 'backups', copy.item.filename))); assert.ok(fs.readdirSync(path.join(directory, 'backups', '.trash')).some(f => f.endsWith(copy.item.filename)));
      assert.equal(db.get('SELECT id FROM backup_records WHERE id=?', [copy.item.id]), undefined);
      await admin(`/backups/${copy.item.id}`, 'DELETE', undefined, 409);
    });
    await t.test('administrator password reset, 2FA reset, session revocation and real deletion retain audit attribution', async () => {
      const old = await login('operator-renamed'); await admin(`/admins/${operatorId}/password`, 'POST', { password: '654321' });
      assert.equal((await request('/admin/session', 'GET', undefined, old)).status, 401);
      const next = await login('operator-renamed', '654321'); db.run("UPDATE admins SET totp_enabled=1,totp_secret='TESTSECRET' WHERE id=?", [operatorId]);
      await admin(`/admins/${operatorId}/reset-2fa`, 'POST', {}); assert.equal(db.get('SELECT totp_enabled FROM admins WHERE id=?', [operatorId])!.totp_enabled, 0); assert.equal((await request('/admin/session', 'GET', undefined, next)).status, 401);
      const current = await login('operator-renamed', '654321'); await admin(`/admins/${operatorId}/sessions`, 'DELETE'); assert.equal((await request('/admin/session', 'GET', undefined, current)).status, 401);
      db.run('UPDATE cdk_batches SET created_by=? WHERE id=?', [operatorId, batch]); db.run('UPDATE backup_records SET created_by=? WHERE id=?', [operatorId, backupId]);
      await admin(`/admins/${operatorId}`, 'DELETE'); assert.equal(db.get('SELECT id FROM admins WHERE id=?', [operatorId]), undefined); assert.equal(db.get('SELECT created_by FROM cdk_batches WHERE id=?', [batch])!.created_by, null);
      const logs = await admin('/audit'); assert.ok(logs.items.length); const retained = db.all('SELECT actor_name FROM audit_logs WHERE action=?', ['admin.login']); assert.ok(retained.some(r => r.actor_name === 'operator-renamed'));
      assert.match((await admin('/audit/export')).content, /operator-renamed/);
    });
    await t.test('package/batch deletion cascades only on explicit confirmation and cannot remove in-flight grants', async () => {
      const b = await admin('/batches', 'POST', { packageId: pkg, quantity: 1, name: '待删除' });
      const id = db.get('SELECT id FROM cdks WHERE batch_id=?', [b.batchId])!.id;
      db.run("INSERT INTO cdk_grants(id,cdk_id,token_hash,status,created_at,expires_at) VALUES ('locked-test',?,'locked-token','locked',?,?)", [id, new Date().toISOString(), new Date(Date.now() + 3600000).toISOString()]);
      await admin(`/batches/${b.batchId}`, 'DELETE', { cascadeCodes: true }, 409); assert.ok(db.get('SELECT id FROM cdks WHERE id=?', [id]));
      db.run("UPDATE cdk_grants SET status='released' WHERE id='locked-test'");
      await admin(`/batches/${b.batchId}`, 'DELETE', {}, 409); await admin(`/batches/${b.batchId}`, 'DELETE', { cascadeCodes: true }); assert.equal(db.get('SELECT id FROM cdks WHERE id=?', [id]), undefined);
      const p = await admin('/packages', 'POST', { name: '删除套餐', maxUses: 1 }); await admin('/batches', 'POST', { packageId: p.id, quantity: 1 }); await admin(`/packages/${p.id}`, 'DELETE', { cascadeCodes: true }); assert.equal(db.get('SELECT id FROM cdk_packages WHERE id=?', [p.id]), undefined);
    });
    await t.test('site identity and all edited business data survive database reopen; audit cleanup leaves its own event', async () => {
      const settings = await admin('/settings'); await admin('/settings', 'PUT', { ...settings, siteName: '正式站点', siteUrl: 'https://panel.example.test' });
      const reopened = await PanelArkDatabase.open(db.filePath);
      try { assert.equal(reopened.get('SELECT value FROM site_settings WHERE key=?', ['site_name'])!.value, '正式站点'); assert.equal(reopened.get('SELECT label FROM backup_records WHERE id=?', [backupId])!.label, '整改验收快照'); assert.equal(reopened.get('SELECT note FROM job_notes WHERE job_id=?', [jobId])!.note, '持久化处理记录'); assert.equal(reopened.get('SELECT name FROM cdk_batches WHERE id=?', [batch])!.name, '批次已重命名'); assert.deepEqual(reopened.all('PRAGMA foreign_key_check'), []); } finally { reopened.close(); }
      db.run("INSERT INTO audit_logs(action,created_at) VALUES ('old-record','2000-01-01T00:00:00.000Z')"); await admin('/audit', 'DELETE', { before: '2001-01-01', confirm: 'DELETE' }); assert.equal(db.get("SELECT id FROM audit_logs WHERE action='old-record'"), undefined); assert.ok(db.get("SELECT id FROM audit_logs WHERE action='audit.cleanup'"));
      assert.equal(db.get('PRAGMA foreign_keys')!.foreign_keys, 1); db.exportBytes(); assert.equal(db.get('PRAGMA foreign_keys')!.foreign_keys, 1);
      assert.throws(() => db.run("INSERT INTO job_notes(id,job_id,note,created_at,updated_at) VALUES ('orphan','missing','invalid','now','now')"), /FOREIGN KEY/);
      await admin(`/jobs/${jobId}`, 'DELETE', { confirm: 'DELETE' }); assert.equal(db.get('SELECT id FROM job_notes WHERE job_id=?', [jobId]), undefined); assert.ok(db.get("SELECT id FROM cdk_grants WHERE id='refund-grant'"));
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); db.close(); fs.rmSync(directory, { recursive: true, force: true }); keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
});
