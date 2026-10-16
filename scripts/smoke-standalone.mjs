import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panelark-standalone-'));
const env = { ...process.env, PANELARK_DATA_DIR: directory, PANELARK_DEPLOYMENT_MODE: 'standalone', NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '1891' };
let child;
function cli(action, input) {
  const r = spawnSync(process.execPath, ['dist/panel-admin.cjs', action], { env, encoding: 'utf8', input: input && JSON.stringify(input) });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
}
async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
async function start() {
  child = spawn(process.execPath, ['dist/server.cjs'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; child.stderr.on('data', d => error += d);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(error || 'server exited early');
    try { if ((await fetch('http://127.0.0.1:1891/api/health')).ok) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy');
}
try {
  const input = { username: 'terminal_owner', password: '123456', siteName: 'Terminal smoke', siteUrl: 'http://127.0.0.1:1891', adminPath: '/terminal-console' };
  assert.equal(cli('initialize', input).created, true); assert.equal(cli('initialize', input).created, false);
  await start();
  const base = 'http://127.0.0.1:1891';
  assert.equal((await fetch(base, { redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${base}/install`)).status, 404);
  assert.equal((await fetch(`${base}/panel-admin.cjs`)).status, 404);
  assert.equal((await fetch(`${base}/server.cjs`)).status, 404);
  assert.equal((await (await fetch(`${base}/api/setup/status`)).json()).enabled, false);
  assert.equal((await fetch(`${base}/api/admin/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
  const login = password => fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: input.username, password }) });
  assert.equal((await login('123456')).status, 200);
  assert.match(await (await fetch(`${base}/terminal-console`)).text(), /data-panelark-view="admin"/);
  const before = fs.statSync(path.join(directory, 'panelark.sqlite')).mtimeMs;
  assert.equal(cli('info').adminPath, '/terminal-console'); assert.equal(fs.statSync(path.join(directory, 'panelark.sqlite')).mtimeMs, before);
  await stop(); cli('password', { username: input.username, password: 'abcdef' }); await start();
  assert.equal((await login('abcdef')).status, 200); assert.equal((await login('123456')).status, 401);
  console.log('PASS standalone terminal initialization, six-character login, info, password reset and restart; no web installer');
} finally { await stop(); fs.rmSync(directory, { recursive: true, force: true }); }
