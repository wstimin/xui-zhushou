import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { officialThreeXUiPolicy, officialThreeXUiReadCommand, parseOfficialThreeXUiResult, OFFICIAL_THREE_XUI_INSTALLER } from './three-xui-install.js';
import { shellQuote } from './ssh.js';
import { createThreeXUiAdapter } from './panel-adapters.js';
import { XuiClient } from './xui-client.js';

const fields = { USERNAME: 'official-owner', PASSWORD: '  p@ss \'"$中文 & =  ', API_TOKEN: 'official-token', PANEL_PORT: '2053', WEB_BASE_PATH: '/actual/', ACCESS_URL: 'https://panel.example:2053/actual/', SETTINGS: 'current panel settings as follows:\nport: 2053\nwebBasePath: /actual/\n', CERTS: 'cert: /cert/fullchain.pem\nkey: /cert/key.pem\n' };
const encoded = (overrides: Record<string, string> = {}) => Object.entries({ ...fields, ...overrides }).map(([key, value]) => `__XUI_OFFICIAL_${key}__=${Buffer.from(value).toString('base64')}`).join('\n');

test('all normal and legacy install choices resolve to the official source, custom installs fail closed', () => {
  for (const scriptType of [undefined, 'official', 'recommended', 'unknown']) assert.equal(officialThreeXUiPolicy({ scriptType }).scriptUrl, OFFICIAL_THREE_XUI_INSTALLER);
  assert.equal(officialThreeXUiPolicy({ autoSSL: true, domain: 'panel.example' }).sslMode, 'domain');
  assert.equal(officialThreeXUiPolicy({ autoSSL: true }).sslMode, 'ip');
  assert.throws(() => officialThreeXUiPolicy({ scriptType: 'custom' }), /仅使用/);
  const command = officialThreeXUiReadCommand(true);
  for (const fragment of ['/etc/x-ui/install-result.env', '/usr/local/x-ui/x-ui', 'setting -show', 'setting -getCert', 'setting -getApiToken', 'base64']) assert.ok(command.includes(fragment));
  assert.match(command, /^sudo -n bash -c/); assert.doesNotMatch(command, /getApiToken true|setting -username|setting -password/);
});

test('official delivery preserves all credential bytes and uses queried TLS state, including IP certificates', () => {
  const result = parseOfficialThreeXUiResult(encoded());
  assert.equal(result.username, fields.USERNAME); assert.equal(result.password, fields.PASSWORD); assert.equal(result.apiToken, fields.API_TOKEN);
  assert.equal(result.accessUrl, 'https://panel.example:2053/actual/'); assert.equal(result.sslEnabled, true);
  const ip = parseOfficialThreeXUiResult(encoded({ ACCESS_URL: 'https://198.51.100.10:2053/actual/' }));
  assert.equal(ip.protocol, 'https'); assert.equal(ip.host, '198.51.100.10');
  const noCert = parseOfficialThreeXUiResult(encoded({ CERTS: 'cert: \nkey: \n' }));
  assert.equal(noCert.accessUrl, 'http://panel.example:2053/actual/'); assert.equal(noCert.sslEnabled, false);
  const standardPort = parseOfficialThreeXUiResult(encoded({ PANEL_PORT: '443', SETTINGS: 'port: 443\nwebBasePath: /actual/\n', ACCESS_URL: 'https://panel.example/actual/' }));
  assert.equal(standardPort.port, '443');
});

test('missing delivery, stale files, partial certificates and inconsistent URLs never fall back to planned credentials', () => {
  for (const change of [
    { PASSWORD: '' }, { USERNAME: '' }, { API_TOKEN: '' }, { ACCESS_URL: '' }, { SETTINGS: '' }, { CERTS: '' },
    { SETTINGS: 'port: 7777\nwebBasePath: /actual/\n' }, { WEB_BASE_PATH: '/old/' }, { ACCESS_URL: 'https://panel.example:2053/old/' },
    { CERTS: 'cert: /cert.pem\nkey: \n' }, { ACCESS_URL: 'https://user:secret@panel.example:2053/actual/' }, { PASSWORD: 'bad\nvalue' },
  ]) assert.throws(() => parseOfficialThreeXUiResult(encoded(change)), /官方/);
  assert.throws(() => parseOfficialThreeXUiResult('active\n'), /官方安装结果/);
  assert.throws(() => parseOfficialThreeXUiResult(encoded() + '\n' + encoded()), /重复/);
});

test('adapter verifies the official credentials over real HTTP and validates the actual bearer token', async () => {
  let logins = 0, tokenChecks = 0, rejectToken = false;
  const requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url!); res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/csrf-token')) { res.end(JSON.stringify({ success: true, obj: 'csrf' })); return; }
    if (req.url === '/actual/login') {
      let body = ''; for await (const data of req) body += data;
      const form = new URLSearchParams(body); logins++;
      assert.equal(form.get('username'), fields.USERNAME); assert.equal(form.get('password'), fields.PASSWORD);
      res.setHeader('set-cookie', '3x-ui=logged-in; Path=/'); res.end(JSON.stringify({ success: true })); return;
    }
    if (req.url === '/actual/panel/api/inbounds/list') {
      tokenChecks++; assert.equal(req.headers.authorization, `Bearer ${fields.API_TOKEN}`);
      res.end(JSON.stringify({ success: !rejectToken, msg: rejectToken ? 'Invalid token' : '', obj: [] })); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const officialOutput = encoded({ PANEL_PORT: String(port), SETTINGS: `port: ${port}\nwebBasePath: /actual/\n`, ACCESS_URL: `http://127.0.0.1:${port}/actual/`, CERTS: 'cert: \nkey: \n' });
  const adapter = createThreeXUiAdapter({ connect: async () => ({ client: { end() {} } }) as any, inspect: async () => ({ status: 'compatible', isRoot: true }) as any, exec: async (_client, command) => ({ code: 0, stdout: command.includes('systemctl is-active') ? officialOutput : '', stderr: '' }), client: options => new XuiClient(options), sleep: async () => {} });
  const payload = { ipOrDomain: '127.0.0.1', panelUsername: 'planned-owner', panelPassword: 'planned-password', panelPort: 55555, panelPath: '/planned/' };
  const context = { payload, jobId: 'test', signal: new AbortController().signal, step: async (_key: string, action: () => Promise<unknown>) => action(), log() {}, progress() {} } as any;
  try {
    const result = await adapter.execute('install', context) as Record<string, unknown>;
    assert.equal(result.username, fields.USERNAME); assert.equal(result.password, fields.PASSWORD); assert.equal(result.port, String(port)); assert.equal(result.path, '/actual/');
    assert.equal(logins, 1); assert.equal(tokenChecks, 1); assert.ok(!requests.some(item => item.includes('getApiToken')));
    rejectToken = true;
    await assert.rejects(adapter.execute('install', context), /Invalid token/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

const shellTest = process.platform === 'linux' ? test : test.skip;
shellTest('real Bash sources official printf-%q credentials and queries official CLI without scraping prompts or resetting credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panelark-official-xui-'));
  const resultFile = path.join(directory, 'install-result.env'), cli = path.join(directory, 'x-ui'), log = path.join(directory, 'calls');
  try {
    fs.writeFileSync(path.join(directory, 'systemctl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const envKeys = ['USERNAME', 'PASSWORD', 'API_TOKEN', 'PANEL_PORT', 'WEB_BASE_PATH', 'ACCESS_URL'];
    const write = spawnSync('bash', ['-c', envKeys.map(key => `printf 'XUI_${key}=%q\\n' ${shellQuote(fields[key as keyof typeof fields])}`).join('\n')], { encoding: 'utf8' });
    assert.equal(write.status, 0, write.stderr); fs.writeFileSync(resultFile, write.stdout);
    fs.writeFileSync(cli, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${shellQuote(log)}\ncase "$*" in\n'setting -show') printf '%s' ${shellQuote(fields.SETTINGS)};;\n'setting -getCert') printf '%s' ${shellQuote(fields.CERTS)};;\n'setting -getApiToken') printf 'apiToken: official-token\\n';;\n*) exit 92;;\nesac\n`, { mode: 0o755 });
    const run = () => spawnSync('bash', ['-c', officialThreeXUiReadCommand(false, { resultFile, cli })], { encoding: 'utf8', env: { ...process.env, PATH: directory + path.delimiter + process.env.PATH } });
    const first = run(); assert.equal(first.status, 0, first.stderr); assert.equal(parseOfficialThreeXUiResult(first.stdout).password, fields.PASSWORD);
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /getApiToken|username|password/);
    fs.writeFileSync(resultFile, write.stdout.replace(/^XUI_API_TOKEN=.*\n/m, 'XUI_API_TOKEN=\n'));
    const fallback = run(); assert.equal(fallback.status, 0, fallback.stderr); assert.equal(parseOfficialThreeXUiResult(fallback.stdout).apiToken, fields.API_TOKEN);
    assert.match(fs.readFileSync(log, 'utf8'), /setting -getApiToken/);
    fs.unlinkSync(resultFile); const missing = run(); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /官方安装结果文件缺失/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
