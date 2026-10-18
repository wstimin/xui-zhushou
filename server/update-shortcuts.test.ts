import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const linuxTest = process.platform === 'linux' ? test : test.skip;
for (const conflict of [false, true]) linuxTest(`real update executor repairs missing shortcuts after swap without reinstalling dependencies (conflict=${conflict})`, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panelark-update-shortcuts-'));
  const target = path.join(directory, 'app'), packaged = path.join(directory, 'package');
  const stateDirectory = path.join(directory, 'state'), updates = path.join(stateDirectory, 'updates');
  const bin = path.join(directory, 'commands'), fakeBin = path.join(directory, 'fake-bin');
  const statePath = path.join(stateDirectory, 'update-state.json'), log = path.join(directory, 'process-actions.log');
  const helperUrl = new URL('../scripts/command-shortcuts.mjs', import.meta.url);
  const server = http.createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ status: 'ok', version: fs.readFileSync(path.join(target, 'VERSION'), 'utf8').trim() })); });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    for (const location of [target, packaged]) {
      fs.mkdirSync(path.join(location, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(location, 'dist'));
      fs.writeFileSync(path.join(location, 'package.json'), '{}'); fs.writeFileSync(path.join(location, 'install.sh'), '#!/usr/bin/env bash\nprintf "MENU_ACTION:<%s>\\n" "$@"\n');
      fs.writeFileSync(path.join(location, 'VERSION'), location === target ? '1.0.0\n' : '1.0.1\n');
      fs.writeFileSync(path.join(location, 'dist/server.cjs'), '// controlled test server');
      fs.writeFileSync(path.join(location, 'ecosystem.config.cjs'), 'module.exports={apps:[]}');
      fs.copyFileSync(new URL('../scripts/apply-update.mjs', import.meta.url), path.join(location, 'scripts/apply-update.mjs'));
      // Redirect only the command publication directory; run the real repair implementation.
      fs.writeFileSync(path.join(location, 'scripts/command-shortcuts.mjs'), `import {repairCommandShortcuts as repair} from ${JSON.stringify(helperUrl.href)}; export function repairCommandShortcuts(options){return repair({...options,shortcutDirectory:${JSON.stringify(bin)}});}`);
      fs.mkdirSync(path.join(location, 'node_modules/express'), { recursive: true });
      fs.writeFileSync(path.join(location, 'node_modules/express/package.json'), '{}');
      fs.mkdirSync(path.join(location, 'node_modules/sql.js/dist'), { recursive: true }); fs.writeFileSync(path.join(location, 'node_modules/sql.js/dist/sql-wasm.wasm'), 'fixture');
    }
    fs.writeFileSync(path.join(target, '.env'), `PORT=${port}\nSSL_CERT=${directory}/no-cert\nSSL_KEY=${directory}/no-key\n`);
    fs.mkdirSync(updates, { recursive: true }); fs.mkdirSync(fakeBin); fs.mkdirSync(bin);
    if (conflict) fs.writeFileSync(path.join(bin, 'pa'), '#!/bin/sh\necho FOREIGN_APP\n');
    const foreign = conflict ? fs.readFileSync(path.join(bin, 'pa'), 'utf8') : '';
    fs.writeFileSync(path.join(fakeBin, 'pm2'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nif [ "$1" = jlist ]; then printf '[]'; fi\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\necho UNEXPECTED_DEPENDENCY_INSTALL >&2\nexit 91\n', { mode: 0o755 });
    const archivePath = path.join(updates, 'release.tar.gz');
    const archive = spawnSync('tar', ['-czf', archivePath, '-C', packaged, '.'], { encoding: 'utf8' }); assert.equal(archive.status, 0, archive.stderr);
    fs.writeFileSync(statePath, JSON.stringify({ phase: 'prepared', progress: 50, currentVersion: '1.0.0', targetVersion: '1.0.1', archivePath, events: [] }));
    child = spawn(process.execPath, [path.join(target, 'scripts/apply-update.mjs'), '--state', statePath, '--target', target], { env: { ...process.env, NODE_ENV: 'production', PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout!.on('data', chunk => output += chunk); child.stderr!.on('data', chunk => output += chunk);
    const timeout = setTimeout(() => child?.kill('SIGKILL'), 15000);
    const [exit] = await once(child, 'exit'); clearTimeout(timeout); assert.equal(exit, 0, output);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.phase, 'completed'); assert.equal(state.currentVersion, '1.0.1'); assert.equal(state.progress, 100);
    assert.equal(fs.existsSync(path.join(directory, '.app.rollback')), false);
    assert.match(fs.readFileSync(log, 'utf8'), /startOrReload ecosystem.config.cjs --update-env\nsave/);
    assert.doesNotMatch(output, /UNEXPECTED_DEPENDENCY_INSTALL/);
    const forwarded = spawnSync(path.join(bin, 'sy'), ['logs'], { encoding: 'utf8' }); assert.equal(forwarded.status, 0, forwarded.stderr); assert.match(forwarded.stdout, /MENU_ACTION:<logs>/);
    if (conflict) { assert.equal(fs.readFileSync(path.join(bin, 'pa'), 'utf8'), foreign); assert.ok(state.events.some((event: {message: string}) => event.message.includes('未覆盖其他程序'))); }
    else { const menu = spawnSync(path.join(bin, 'pa'), [], { encoding: 'utf8' }); assert.equal(menu.status, 0, menu.stderr); assert.match(menu.stdout, /MENU_ACTION:<>/); }
    assert.equal(fs.readdirSync(bin).length, 2);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
