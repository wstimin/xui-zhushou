import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import express from 'express';
import ssh2 from 'ssh2';
import { executeAutomaticDeployment } from './automatic-deployment.js';
import { mountPanelArkApi } from './panelark-api.js';
import { registerPanelAdapter, threeXUiMetadata, type PanelAdapter } from './panel-adapters.js';
import { issueTestCdk } from './test-cdk.js';


const environment = { osId: 'ubuntu', osVersion: '22.04', osName: 'Ubuntu 22.04', arch: 'x86_64', packageManager: 'apt', systemdAvailable: true, isRoot: true, totalRamMb: 4096, diskFreeMb: 20000 };
const dependencies = ['CURL', 'CA_CERTIFICATES', 'TAR', 'GZIP', 'UNZIP', 'OPENSSL', 'SOCAT', 'IPROUTE2'].map(name => `__DEP_${name}__=yes`).join('\n');
function context(payload: Record<string, any>) { return { payload, jobId: 'automatic-test', signal: new AbortController().signal, attempt: 1, step: async (_key: string, task: () => Promise<any>) => task(), log() {}, progress() {}, residue() {}, checkCancelled() {} }; }
const session = { alive: true, client: {}, host: 'example.test', port: 22, user: 'root' } as any;

test('automatic installation allocates free ports, installs missing dependencies and initializes New API without confirmations', async () => {
  const commands: string[] = []; let dependencyChecks = 0, occupied = true, installed = false;
  const payload: Record<string, any> = { sshSession: session };
  const adapter: PanelAdapter = { metadata: { ...threeXUiMetadata, id: 'new-api', port: '3000' }, execute: async (_operation, ctx) => { installed = true; assert.notEqual(ctx.payload.servicePort, 3000); return { accessUrl: `http://example.test:${ctx.payload.servicePort}`, port: ctx.payload.servicePort }; } };
  const result = await executeAutomaticDeployment(adapter, payload, context(payload), {
    inspect: async () => environment as any, sudo: async () => true,
    exec: async (_client, command) => {
      commands.push(command); let stdout = '';
      if (command.includes('__DEP_CURL__')) { stdout = dependencyChecks++ === 0 ? dependencies.replace('__DEP_CURL__=yes', '__DEP_CURL__=no') : dependencies; }
      else if (command.includes('__PORT__')) { const port = Number(command.match(/for p in (\d+)/)?.[1]); stdout = `__PORT__=${port}|${occupied ? 'LISTEN occupied' : ''}`; occupied = false; }
      else if (command.includes('__FIREWALL__')) stdout = '__FIREWALL__=ufw\n__FIREWALL_ACTIVE__=yes';
      else if (command.includes('/api/')) stdout = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify({ success: true, data: command.includes('/api/setup') && command.includes('-X GET') ? { status: false, root_init: false } : {} });
      return { code: 0, stdout, stderr: '' };
    },
  });
  assert.equal(installed, true); assert.match(String(result.username), /^ark_/); assert.ok(String(result.password).length >= 12);
  assert.ok(commands.some(command => command.includes('apt-get install') && command.includes('curl')));
  assert.ok(commands.some(command => command.includes('ufw allow')));
  assert.ok(commands.some(command => command.includes('/api/setup') && command.includes('confirmPassword')));
  assert.ok(commands.some(command => command.includes('/api/user/login')));
  assert.ok(commands.every(command => !/systemctl stop|docker rm|rm -rf/.test(command)));
});

test('automatic 3x-ui requests always select the official unattended installer', async () => {
  const payload: Record<string, any> = { sshSession: session, scriptType: 'recommended' };
  let installed = false;
  const adapter: PanelAdapter = { metadata: threeXUiMetadata, execute: async (_operation, ctx) => {
    installed = true; assert.equal(ctx.payload.scriptType, 'official'); assert.equal(ctx.payload.autoSSL, true);
    return { scriptType: ctx.payload.scriptType };
  } };
  await executeAutomaticDeployment(adapter, payload, context(payload), { inspect: async () => environment as any, sudo: async () => true, exec: async (_client, command) => ({ code: 0, stdout: command.includes('__DEP_') ? dependencies : command.includes('__FIREWALL__') ? '__FIREWALL__=none\n__FIREWALL_ACTIVE__=no' : '', stderr: '' }) });
  assert.equal(installed, true);
});

test('automatic installation rejects fixed-port conflicts and unsupported hosts without stopping services', async () => {
  let installed = false;
  const adapter: PanelAdapter = { metadata: { ...threeXUiMetadata, id: 'fixed-panel', port: '80' }, execute: async () => { installed = true; return {}; } };
  const payload = { sshSession: session };
  const exec: any = async (_: any, command: string) => ({ code: 0, stdout: command.includes('__DEP_') ? dependencies : command.includes('__PORT__') ? '__PORT__=80|LISTEN occupied' : '', stderr: '' });
  await assert.rejects(executeAutomaticDeployment(adapter, payload, context(payload), { inspect: async () => environment as any, sudo: async () => true, exec }), /端口 80/);
  await assert.rejects(executeAutomaticDeployment(adapter, payload, context(payload), { inspect: async () => ({ ...environment, osId: 'alpine' }) as any, sudo: async () => true, exec }), /不支持/);
  assert.equal(installed, false);
});


test('automatic HTTP tasks start immediately, settle authorization and keep private delivery behind a page-only receipt until explicit acknowledgement', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panelark-automatic-http-'));
  const saved = process.env.PANELARK_DATA_DIR; process.env.PANELARK_DATA_DIR = directory;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const clients = new Set<any>();
  const ssh = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client));
    client.on('authentication', auth => auth.method === 'password' && auth.password === 'test-password' ? auth.accept() : auth.reject());
    client.on('ready', () => client.on('session', accept => accept().on('exec', acceptExec => {
      const stream = acceptExec(); stream.write(['__OS__=Ubuntu 22.04', '__OS_ID__=ubuntu', '__OS_VERSION__=22.04', '__ARCH__=x86_64', '__SYSTEMD_ACTIVE__=yes', '__RAM_KB__=4194304', '__FREE_KB__=3145728', '__DISK_FREE_KB__=52428800', '__UID__=0', '__CURL__=yes', '__PKG_MANAGER__=apt', dependencies, '__FIREWALL__=none', '__FIREWALL_ACTIVE__=no'].join('\n')); stream.exit(0); stream.end();
    })));
  });
  ssh.listen(0, '127.0.0.1'); await new Promise<void>(resolve => ssh.once('listening', resolve));
  const app = express(); app.use(express.json()); const services = await mountPanelArkApi(app);
  let runs = 0, failInstall = false;
  registerPanelAdapter({ metadata: { ...threeXUiMetadata, id: 'automatic-fixture', port: '无需端口' }, async execute(_operation, ctx) { runs++; return ctx.step('install', async () => { if (failInstall) throw new Error('测试安装失败：软件源不可达'); return { username: 'installed-admin', password: 'retained-password', managementKey: 'retained-key' }; }); } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const request = (route: string, body?: object, headers: Record<string, string> = {}) => fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    const code = issueTestCdk(services.db, directory, 'PAK-AUTOMATIC-TEST', 1);
    const grant = await (await request('/cdk/validate', { code })).json();
    const connected = await (await request('/server/connect', { grantToken: grant.grantToken, connection: { ipOrDomain: '127.0.0.1', sshPort: (ssh.address() as any).port, sshUser: 'root', sshPassword: 'test-password' } })).json();
    assert.equal((await request('/server/inspect', { grantToken: grant.grantToken, serverSessionId: connected.serverSessionId, fingerprint: connected.fingerprint })).status, 200);
    assert.equal((await request('/cdk/lock', { grantToken: grant.grantToken, taskKey: 'automatic-task' })).status, 200);
    const response = await request('/jobs', { grantToken: grant.grantToken, taskKey: 'automatic-task', adapterId: 'automatic-fixture', operation: 'install', serverKey: 'automatic-server', payload: { autoDeploy: true, serverSessionId: connected.serverSessionId } });
    assert.equal(response.status, 201);
    const created = await response.json(), receipt = created.receipt;
    assert.ok(receipt); assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(grant.totalUses, 1); assert.equal(grant.usedCount, 0); assert.equal(grant.remaining, 1);
    let current: any;
    for (let attempt = 0; attempt < 100; attempt++) {
      current = await (await request('/deployment/current', undefined, { 'x-panelark-delivery': receipt })).json();
      if (current.job.status === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(current.job.status, 'succeeded'); assert.equal(runs, 1);
    assert.equal(current.result.password, 'retained-password'); assert.equal(current.result.managementKey, 'retained-key');
    assert.equal(services.db.get('SELECT used_count FROM cdks')?.used_count, 1);
    assert.equal((await request('/deployment/current')).headers.get('cache-control'), 'no-store');
    assert.equal((await (await request('/deployment/current')).json()).job, null);
    assert.equal((await request('/deployment/current/acknowledge', {}, { 'x-panelark-delivery': receipt })).status, 403);
    assert.doesNotMatch(fs.readFileSync(path.join(directory, 'panelark.sqlite')).toString('latin1'), /retained-password|retained-key|test-password/);
    // Re-reading after CDK consumption must keep the exact credential payload.
    assert.equal((await (await request('/deployment/current', undefined, { 'x-panelark-delivery': receipt })).json()).result.password, 'retained-password');
    assert.equal((await request('/deployment/current/acknowledge', {}, { 'x-panelark-delivery': receipt, 'x-panelark-result': created.job.id })).status, 200);
    assert.equal((await (await request('/deployment/current', undefined, { 'x-panelark-delivery': receipt })).json()).job, null);
    assert.deepEqual(current.usage, { totalUses: 1, usedCount: 1, lockedCount: 0, remaining: 0 });
    failInstall = true;
    const retryCode = issueTestCdk(services.db, directory, 'PAK-AUTOMATIC-FAILURE', 1);
    const secondGrant = await (await request('/cdk/validate', { code: retryCode })).json();
    const secondConnection = await (await request('/server/connect', { grantToken: secondGrant.grantToken, connection: { ipOrDomain: '127.0.0.1', sshPort: (ssh.address() as any).port, sshUser: 'root', sshPassword: 'test-password' } })).json();
    await request('/server/inspect', { grantToken: secondGrant.grantToken, serverSessionId: secondConnection.serverSessionId, fingerprint: secondConnection.fingerprint });
    await request('/cdk/lock', { grantToken: secondGrant.grantToken, taskKey: 'automatic-failure-task' });
    const secondResponse = await request('/jobs', { grantToken: secondGrant.grantToken, taskKey: 'automatic-failure-task', adapterId: 'automatic-fixture', operation: 'install', serverKey: 'automatic-server', payload: { autoDeploy: true, serverSessionId: secondConnection.serverSessionId } });
    assert.equal(secondResponse.status, 201);
    const secondReceipt = (await secondResponse.json()).receipt;
    for (let attempt = 0; attempt < 100; attempt++) {
      current = await (await request('/deployment/current', undefined, { 'x-panelark-delivery': secondReceipt })).json();
      if (current.job.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(current.job.status, 'failed'); assert.match(current.job.errorMessage, /软件源不可达/);
    assert.equal(services.db.get("SELECT status FROM cdk_grants WHERE task_key = 'automatic-failure-task'")?.status, 'released');
    assert.equal((await request('/cdk/validate', { code: retryCode })).status, 200, 'failed automatic task does not consume a use');
  } finally {
    for (const client of clients) client.end();
    await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => ssh.close(() => resolve())); services.db.close(); fs.rmSync(directory, { recursive: true, force: true });
    if (saved === undefined) delete process.env.PANELARK_DATA_DIR; else process.env.PANELARK_DATA_DIR = saved;
  }
});
