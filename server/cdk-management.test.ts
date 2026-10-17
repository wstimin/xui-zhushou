import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { encryptCdkCode, decryptCdkCode } from './cdk-management.js';
import { hashCdk, loadOrCreatePepper } from './panelark-security.js';
import { mountPanelArkApi } from './panelark-api.js';
import { createBackupArchive, decryptBackup } from './panelark-backup.js';
import { PanelArkDatabase } from './panelark-db.js';

test('CDK encryption authenticates its key, record ID and hash and preserves legacy hashes', () => {
  const pepper = Buffer.alloc(32, 7), code = 'PAK-ABCD-EFGH-JKLM', id = 'cdk-id';
  const encrypted = encryptCdkCode(code, pepper, id);
  const row = { id, code_hash: hashCdk(code, pepper), code_encrypted: encrypted };
  assert.equal(decryptCdkCode(row, pepper), code);
  assert.notEqual(encryptCdkCode(code, pepper, id), encrypted);
  assert.doesNotMatch(encrypted, /PAK-|ABCD/);
  assert.throws(() => decryptCdkCode(row, Buffer.alloc(32, 8)), /解密失败/);
  assert.throws(() => decryptCdkCode({ ...row, id: 'other' }, pepper), /解密失败/);
  assert.throws(() => decryptCdkCode({ ...row, code_hash: '0'.repeat(64) }, pepper), /解密失败/);
  assert.throws(() => decryptCdkCode({ ...row, code_encrypted: 'v1.bad.tag.data' }, pepper), /解密失败/);
  assert.equal(decryptCdkCode({ ...row, code_encrypted: null }, pepper), null);
});

test('upgrading the pre-encryption schema preserves legacy CDKs and their entitlements', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panelark-cdk-migration-'));
  const file = path.join(directory, 'panelark.sqlite');
  let db = await PanelArkDatabase.open(file);
  try {
    const timestamp = new Date().toISOString(), pepper = Buffer.alloc(32, 5);
    db.run('ALTER TABLE cdks DROP COLUMN code_encrypted');
    db.run('ALTER TABLE cdks DROP COLUMN max_uses_override');
    db.run('DELETE FROM schema_migrations WHERE version = 6');
    db.run("INSERT INTO cdk_packages(id, name, max_uses, created_at, updated_at) VALUES ('legacy-package', '旧套餐', 5, ?, ?)", [timestamp, timestamp]);
    db.run("INSERT INTO cdks(id, package_id, code_hash, code_hint, used_count, created_at, updated_at) VALUES ('legacy-code', 'legacy-package', ?, '…JKLM', 2, ?, ?)", [hashCdk('PAK-ABCD-EFGH-JKLM', pepper), timestamp, timestamp]);
    db.close(); db = await PanelArkDatabase.open(file);
    const row = db.get("SELECT * FROM cdks WHERE id = 'legacy-code'")!;
    assert.equal(row.used_count, 2); assert.equal(row.code_encrypted, null); assert.equal(row.max_uses_override, null);
    assert.equal(row.code_hash, hashCdk('PAK-ABCD-EFGH-JKLM', pepper));
    assert.equal(decryptCdkCode(row, pepper), null);
    assert.ok(db.get('SELECT version FROM schema_migrations WHERE version = 6'));
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('administrators can recover, export, edit and delete CDKs with role, CSRF, lock and persistence checks', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panelark-cdk-management-'));
  const saved = { data: process.env.PANELARK_DATA_DIR, mode: process.env.PANELARK_DEPLOYMENT_MODE, token: process.env.PANELARK_SETUP_TOKEN };
  process.env.PANELARK_DATA_DIR = directory; process.env.PANELARK_DEPLOYMENT_MODE = 'panel'; process.env.PANELARK_SETUP_TOKEN = 'test-setup-token';
  const app = express(); app.use(express.json()); const services = await mountPanelArkApi(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const request = (route: string, method = 'GET', body?: object, headers: Record<string, string> = {}) => fetch(base + route, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = async (response: Response) => response.json() as Promise<any>;
  try {
    const bootResponse = await request('/admin/bootstrap', 'POST', { setupToken: 'test-setup-token', username: 'owner', password: '123456' });
    const boot = await json(bootResponse);
    const ownerHeaders = { cookie: bootResponse.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': boot.csrfToken };
    const admin = (route: string, method = 'GET', body?: object) => request('/admin' + route, method, body, ownerHeaders);
    const pkg = await json(await admin('/packages', 'POST', { name: '=Unsafe spreadsheet name', maxUses: 5 }));
    const batch = await json(await admin('/batches', 'POST', { packageId: pkg.id, name: '完整导出批次', quantity: 121 }));
    assert.equal(batch.codes.length, 121);
    assert.match(batch.warning, /随时/);
    const listed = await json(await admin(`/cdks?batchId=${batch.batchId}&pageSize=10`));
    assert.equal(listed.pagination.total, 121); assert.equal(listed.items.length, 10);
    assert.equal(listed.items[0].code_available, 1);
    const id = listed.items[0].id;
    assert.doesNotMatch(JSON.stringify(listed), /PAK-|code_hash|code_encrypted/);
    const revealed = await json(await admin(`/cdks/${id}/reveal`, 'POST', {}));
    assert.ok(batch.codes.includes(revealed.code));
    assert.equal((await admin(`/cdks/${id}/reveal`, 'POST', {})).headers.get('cache-control'), 'no-store');
    assert.equal((await request(`/admin/cdks/${id}/reveal`, 'POST', {})).status, 401);
    assert.equal((await request('/admin/cdks/export', 'POST', { scope: 'filtered' }, { cookie: ownerHeaders.cookie })).status, 403);
    const all = await json(await admin('/cdks/export', 'POST', { scope: 'filtered', filters: { batchId: batch.batchId }, format: 'txt' }));
    assert.equal(all.total, 121); assert.equal(all.exported, 121);
    assert.equal(all.content.trim().split('\n').length, 121);
    assert.deepEqual(new Set(all.content.trim().split('\n')), new Set(batch.codes));
    assert.equal((await admin('/cdks/export', 'POST', { scope: 'filtered' })).headers.get('cache-control'), 'no-store');
    const search = await json(await admin(`/cdks?search=${encodeURIComponent(revealed.code)}`));
    assert.equal(search.pagination.total, 1); assert.equal(search.items[0].id, id);
    assert.equal((await json(await admin('/cdks?search=%25'))).pagination.total, 0);
    const batches = await json(await admin('/batches')); assert.equal(batches.items[0].id, batch.batchId);

    // Per-code entitlement changes must reach real public validation and locking.
    assert.equal((await admin(`/cdks/${id}`, 'PATCH', { status: 'active', usedCount: 6, maxUses: 7, expiresAt: null })).status, 200);
    const grant = await json(await request('/cdk/validate', 'POST', { code: revealed.code }));
    assert.equal(grant.remaining, 1);
    assert.equal((await request('/cdk/lock', 'POST', { grantToken: grant.grantToken, taskKey: 'management-lock' })).status, 200);
    assert.equal((await admin(`/cdks/${id}`, 'DELETE')).status, 409);
    assert.equal((await admin(`/cdks/${id}`, 'PATCH', { status: 'disabled' })).status, 409);
    const otherId = listed.items[1].id;
    assert.equal((await admin('/cdks/bulk', 'POST', { ids: [otherId, id], action: 'delete' })).status, 409);
    assert.ok(services.db.get('SELECT id FROM cdks WHERE id = ?', [otherId]), 'bulk delete is atomic');
    assert.equal((await request('/cdk/release', 'POST', { grantToken: grant.grantToken, taskKey: 'management-lock' })).status, 200);
    assert.equal((await admin(`/cdks/${id}`, 'PATCH', { maxUses: 2 })).status, 409);
    assert.equal((await admin(`/cdks/${id}`, 'PATCH', { expiresAt: 'not-a-date' })).status, 409);
    assert.equal((await admin(`/cdks/${id}`, 'PATCH', { usedCount: 0, maxUses: 9 })).status, 200);
    const unchanged = services.db.get('SELECT max_uses FROM cdk_packages WHERE id = ?', [pkg.id]); assert.equal(unchanged?.max_uses, 5);
    const activeGrant = await json(await request('/cdk/validate', 'POST', { code: revealed.code }));
    assert.equal((await admin('/cdks/bulk', 'POST', { ids: [id, otherId], action: 'status', status: 'disabled' })).status, 200);
    assert.equal((await request('/cdk/lock', 'POST', { grantToken: activeGrant.grantToken, taskKey: 'disabled-code' })).status, 409);
    assert.equal((await json(await admin('/cdks?status=disabled'))).pagination.total, 2);
    assert.equal((await admin('/cdks/bulk', 'POST', { ids: [id, otherId], action: 'status', status: 'active' })).status, 200);

    // Legacy hashes still validate; admins can bind only the matching original.
    services.db.run('UPDATE cdks SET code_encrypted = NULL WHERE id = ?', [id]);
    assert.equal((await admin(`/cdks/${id}/reveal`, 'POST', {})).status, 400);
    assert.equal((await admin('/cdks/export', 'POST', { ids: [id], format: 'txt' })).status, 400);
    const mixed = await json(await admin('/cdks/export', 'POST', { ids: [id, otherId], format: 'txt' }));
    assert.equal(mixed.unavailable, 1); assert.equal(mixed.exported, 1);
    const csv = await json(await admin('/cdks/export', 'POST', { ids: [id, otherId], format: 'csv' }));
    assert.equal(csv.total, 2); assert.match(csv.content, /旧版哈希不可还原/);
    assert.match(csv.content, /'=Unsafe spreadsheet name/);
    assert.equal((await admin(`/cdks/${id}`, 'PATCH', { originalCode: 'PAK-INVALID' })).status, 409);
    assert.equal((await admin(`/cdks/${id}`, 'PATCH', { originalCode: revealed.code })).status, 200);
    assert.equal((await json(await admin(`/cdks/${id}/reveal`, 'POST', {}))).code, revealed.code);

    for (const role of ['operator', 'support']) {
      assert.equal((await admin('/admins', 'POST', { username: role, password: '123456', role })).status, 200);
      const loginResponse = await request('/admin/login', 'POST', { username: role, password: '123456' }); const login = await json(loginResponse);
      const headers = { cookie: loginResponse.headers.get('set-cookie')!.split(';')[0], 'x-csrf-token': login.csrfToken };
      assert.equal((await request(`/admin/cdks/${id}/reveal`, 'POST', {}, headers)).status, role === 'operator' ? 200 : 403);
      assert.equal((await request('/admin/cdks/export', 'POST', { ids: [id], format: 'txt' }, headers)).status, role === 'operator' ? 200 : 403);
      if (role === 'support') {
        assert.equal((await request(`/admin/cdks/${id}`, 'DELETE', undefined, headers)).status, 403);
        assert.equal((await request('/admin/cdks/bulk', 'POST', { ids: [id], action: 'delete' }, headers)).status, 403);
      }
    }
    const pepper = loadOrCreatePepper(directory);
    const file = path.join(directory, 'panelark.sqlite');
    const reopened = await PanelArkDatabase.open(file);
    try { assert.equal(decryptCdkCode(reopened.get('SELECT * FROM cdks WHERE id = ?', [id])!, pepper), revealed.code); }
    finally { reopened.close(); }
    const archive = createBackupArchive(services.db, directory, '123456');
    const restored = decryptBackup(archive, '123456');
    assert.equal(archive.includes(Buffer.from(revealed.code)), false);
    const restoredDb = await PanelArkDatabase.open(path.join(directory, 'restored.sqlite'));
    try {
      restoredDb.replaceFromBytes(Buffer.from(restored.database, 'base64'));
      assert.equal(decryptCdkCode(restoredDb.get('SELECT * FROM cdks WHERE id = ?', [id])!, Buffer.from(restored.cdkPepper, 'base64')), revealed.code);
    } finally { restoredDb.close(); }
    for (const code of batch.codes) assert.equal(fs.readFileSync(file).includes(Buffer.from(code)), false);
    assert.doesNotMatch(JSON.stringify(services.db.all('SELECT * FROM audit_logs')), /PAK-/);
    assert.equal((await admin('/cdks/export', 'POST', { ids: [] })).status, 400);
    assert.equal((await admin('/cdks/export', 'POST', { ids: ['missing'] })).status, 400);
    assert.equal((await admin('/cdks/export', 'POST', { scope: 'filtered', filters: { status: 'invalid' } })).status, 400);
    assert.equal((await admin('/cdks/bulk', 'POST', { action: 'delete' })).status, 409);
    const removableCode = (await json(await admin(`/cdks/${otherId}/reveal`, 'POST', {}))).code;
    assert.equal((await admin(`/cdks/${otherId}`, 'DELETE')).status, 200);
    assert.equal((await request('/cdk/validate', 'POST', { code: removableCode })).status, 400);
    assert.equal((await admin('/cdks/bulk', 'POST', { ids: [id, listed.items[2].id], action: 'delete' })).status, 200);
    assert.equal((await json(await admin(`/cdks?batchId=${batch.batchId}`))).pagination.total, 118);
    // Restore an archive from a different server key without restarting the API.
    const foreignDirectory = path.join(directory, 'foreign'); fs.mkdirSync(foreignDirectory);
    const foreignPepper = Buffer.alloc(32, 9); fs.writeFileSync(path.join(foreignDirectory, 'panelark.secret'), foreignPepper);
    const foreignDb = await PanelArkDatabase.open(path.join(foreignDirectory, 'panelark.sqlite'));
    let foreignArchive: Buffer;
    const retained = services.db.get('SELECT * FROM cdks WHERE id = ?', [listed.items[3].id])!;
    const retainedCode = decryptCdkCode(retained, pepper)!;
    try {
      foreignDb.replaceFromBytes(services.db.exportBytes());
      foreignDb.transaction(() => {
        for (const row of foreignDb.all('SELECT * FROM cdks')) {
          const code = decryptCdkCode(row, pepper)!;
          foreignDb.run('UPDATE cdks SET code_hash = ?, code_encrypted = ? WHERE id = ?', [hashCdk(code, foreignPepper), encryptCdkCode(code, foreignPepper, String(row.id)), row.id]);
        }
      });
      foreignArchive = createBackupArchive(foreignDb, foreignDirectory, '123456');
    } finally { foreignDb.close(); }
    const uploaded = await json(await fetch(base + '/admin/backups/upload', { method: 'POST', headers: { ...ownerHeaders, 'content-type': 'application/octet-stream' }, body: new Uint8Array(foreignArchive) }));
    assert.equal((await admin(`/backups/${uploaded.id}/restore`, 'POST', { passphrase: '123456' })).status, 200);
    assert.equal((await json(await admin(`/cdks/${retained.id}/reveal`, 'POST', {}))).code, retainedCode);
    assert.equal((await request('/cdk/validate', 'POST', { code: retainedCode })).status, 200);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); services.db.close(); fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries({ PANELARK_DATA_DIR: saved.data, PANELARK_DEPLOYMENT_MODE: saved.mode, PANELARK_SETUP_TOKEN: saved.token })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
