import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { registerCatalogAdapters } from './catalog-adapters.js';
import { initializeAutomaticAccount } from './automatic-accounts.js';

const http = (data: unknown, cookie = '') => `HTTP/1.1 200 OK\r\n${cookie ? `Set-Cookie: ${cookie}\r\n` : ''}Content-Type: application/json\r\n\r\n${JSON.stringify(data)}`;
for (const id of ['portainer', 'npm', 'casaos', 'marzban', 'nezha']) test(`${id}: automatic initialization verifies real login before success`, async () => {
  const commands: string[] = [], saved: any[] = [];
  const result: Record<string, any> = { accessUrl: `http://example.test:${id === 'portainer' ? 9443 : 8000}` };
  await initializeAutomaticAccount(id, result, { ipOrDomain: 'example.test', __automaticCredentials: { username: 'test-admin', password: 'test-password!9' } }, async command => {
    commands.push(command);
    if (command.includes('docker logs')) return 'a'.repeat(64);
    if (command.includes('/users/admin/init')) return http({ Id: 1 });
    if (command.includes('/api/auth')) return http({ jwt: 'jwt' });
    if (command.includes('/api/tokens')) return http({ token: 'jwt' });
    if (command.includes('/v1/users/status')) return http({ success: 200, data: { initialized: false, key: 'registration-key' } });
    if (command.includes('/v1/users/login')) return http({ success: 200, data: { token: { access_token: 'jwt' } } });
    if (command.includes('/api/admin/token')) return http({ access_token: 'jwt' });
    if (command.includes('/api/v1/login')) return http({ success: true, data: { token: 'jwt' } }, 'nz-csrf=signed-test; Path=/');
    if (command.includes('marzban-cli')) return 'Admin created';
    return http({ success: true });
  }, command => command, value => saved.push({ ...value }));
  assert.equal(result.username, 'test-admin'); assert.equal(result.password, 'test-password!9');
  assert.match(result.installInfo, /真实登录验证通过/); assert.ok(saved.length >= 2);
  if (id === 'portainer') assert.ok(commands.some(command => command.includes('X-Setup-Token: ' + 'a'.repeat(64))));
  if (id === 'nezha') assert.ok(commands.some(command => command.includes('X-CSRF-Token: signed-test') && command.includes('original_password')));
  if (id === 'marzban') assert.ok(commands.some(command => command.includes('exec -T') && command.includes('--telegram-id 0') && command.includes('--discord-webhook')));
  const bash = process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(file => fs.existsSync(file)) : 'bash';
  if (bash) for (const command of commands) assert.equal(spawnSync(bash, ['-n'], { input: command, encoding: 'utf8' }).status, 0, 'account command must be valid shell');
});

test('existing accounts are never overwritten and failed login retains already-created credentials', async () => {
  let calls = 0;
  await assert.rejects(initializeAutomaticAccount('casaos', { accessUrl: 'http://example.test' }, {}, async () => { calls++; return http({ success: 200, data: { initialized: true } }); }, command => command, () => {}), /已存在管理员/);
  assert.equal(calls, 1);
  const saved: any[] = [];
  await assert.rejects(initializeAutomaticAccount('portainer', { accessUrl: 'https://example.test:9443' }, { __automaticCredentials: { username: 'created-admin', password: 'created-password' } }, async command => command.includes('/users/admin/init') ? http({ Id: 1 }) : command.includes('/api/auth') ? http({}) : '', command => command, value => saved.push({ ...value })), /登录验证失败/);
  assert.equal(saved[0].password, 'created-password');
});

test('Hiddify returns the actual secret admin link and rejects missing delivery data', async () => {
  const result = { accessUrl: 'https://example.test' };
  await initializeAutomaticAccount('hiddify', result, {}, async command => command.startsWith('cat ') ? JSON.stringify({ panel_links: ['https://example.test/secret-admin/'] }) : '', command => command, () => {});
  assert.equal(result.accessUrl, 'https://example.test/secret-admin/');
  await assert.rejects(initializeAutomaticAccount('hiddify', { accessUrl: 'https://example.test' }, {}, async () => '{}', command => command, () => {}), /未读取到真实管理员入口/);
});

test('Uptime Kuma uses its actual setup and login socket events without a browser wizard', async () => {
  const result: Record<string, any> = { accessUrl: 'http://example.test:3001' };
  let script = '';
  await initializeAutomaticAccount('uptime-kuma', result, { __automaticCredentials: { username: 'test-admin', password: 'test-password!9' } }, async command => {
    script = command.slice(command.indexOf("node -e '") + 9, command.lastIndexOf("'; code="));
    return '__ADMIN_CREATED__\n__LOGIN_VERIFIED__\n__ACCOUNT_EXIT__=0';
  }, command => command, () => {});
  const events: string[] = [], output: string[] = [];
  const socket = { close() {}, on(event: string, callback: () => void) { if (event === 'connect') callback(); }, emit(event: string, ...args: any[]) { events.push(event); args.at(-1)(event === 'needSetup' ? true : { ok: true }); } };
  vm.runInNewContext(script.replaceAll(`'"'"'`, "'"), { require: () => ({ io: () => socket }), console: { log: (line: string) => output.push(line) }, setTimeout: () => 1, clearTimeout() {}, process: { exit: () => assert.fail('socket setup failed') } });
  assert.deepEqual(events, ['needSetup', 'setup', 'login']); assert.ok(output.includes('__LOGIN_VERIFIED__'));
  assert.equal(result.username, 'test-admin');
});

test('automatic NPM injects generated credentials and Hiddify exits its installer menu without user input', async () => {
  const commands: string[] = [];
  const adapters = registerCatalogAdapters({
    inspect: async () => ({ osId: 'ubuntu', osVersion: '22.04', arch: 'x86_64', packageManager: 'apt', isRoot: true, systemdAvailable: true, totalRamMb: 4096, diskFreeMb: 20000 }) as any,
    exec: async (_client, command) => { commands.push(command); return { code: 0, stdout: 'active\nnpm\n', stderr: '' }; },
  });
  for (const id of ['npm', 'hiddify']) {
    commands.length = 0;
    await adapters.find(adapter => adapter.metadata.id === id)!.execute('install', { payload: { autoDeploy: true, ipOrDomain: 'example.test', sshSession: { alive: true, client: {}, host: 'example.test', port: 22, user: 'root' }, __automaticCredentials: { username: 'test@panelark.local', password: 'test-password!9' } }, step: async (_key: string, run: () => Promise<any>) => run(), log() {}, progress() {}, checkCancelled() {}, residue() {}, jobId: 'syntax', attempt: 1, signal: new AbortController().signal } as any);
    const install = commands.at(-2)!;
    if (id === 'npm') { assert.match(install, /INITIAL_ADMIN_EMAIL=test@panelark.local/); assert.match(install, /INITIAL_ADMIN_PASSWORD=test-password!9/); }
    else { assert.match(install, /setsid bash/); assert.match(install, /<\/dev\/null/); assert.match(install, /Finished!/); assert.match(install, /current.json/); }
    const bash = process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(file => fs.existsSync(file)) : 'bash';
    if (bash) { const checked = spawnSync(bash, ['-n'], { input: install, encoding: 'utf8' }); assert.equal(checked.status, 0, checked.stderr); }
  }
});
