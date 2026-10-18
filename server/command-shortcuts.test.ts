import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { repairCommandShortcuts, shortcutContent } from '../scripts/command-shortcuts.mjs';
import { ensureStandaloneShortcuts } from './command-shortcuts.js';

const helper = new URL('../scripts/command-shortcuts.mjs', import.meta.url);
function fixture(run: (directory: string, target: string, bin: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panelark-shortcuts-'));
  const target = path.join(directory, 'app with spaces'), bin = path.join(directory, 'bin');
  fs.mkdirSync(path.join(target, 'scripts'), { recursive: true });
  fs.copyFileSync(helper, path.join(target, 'scripts/command-shortcuts.mjs'));
  fs.writeFileSync(path.join(target, 'install.sh'), '#!/usr/bin/env bash\nprintf "MENU_ACTION:<%s>\\n" "$@"\n');
  try { run(directory, target, bin); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('missing pa and sy are recreated atomically; repeated repairs do not rewrite working commands', () => fixture((_directory, target, bin) => {
  assert.deepEqual(repairCommandShortcuts({ targetDirectory: target, shortcutDirectory: bin }).repaired, ['pa', 'sy']);
  for (const name of ['pa', 'sy']) assert.equal(fs.readFileSync(path.join(bin, name), 'utf8'), shortcutContent(target));
  const before = fs.statSync(path.join(bin, 'pa')).mtimeMs;
  const result = repairCommandShortcuts({ targetDirectory: target, shortcutDirectory: bin });
  if (process.platform !== 'win32') assert.deepEqual(result.unchanged, ['pa', 'sy']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(bin, 'pa')).mtimeMs, before);
  fs.unlinkSync(path.join(bin, 'pa'));
  assert.deepEqual(repairCommandShortcuts({ targetDirectory: target, shortcutDirectory: bin }).repaired, process.platform === 'win32' ? ['pa', 'sy'] : ['pa']);
  assert.equal(fs.readdirSync(bin).length, 2);
}));

test('a foreign pa is preserved byte-for-byte while missing sy is repaired', () => fixture((_directory, target, bin) => {
  fs.mkdirSync(bin);
  const foreign = `#!/bin/sh\n# another application mentions ${target}/install.sh\necho FOREIGN\n`;
  fs.writeFileSync(path.join(bin, 'pa'), foreign);
  const result = repairCommandShortcuts({ targetDirectory: target, shortcutDirectory: bin });
  assert.deepEqual(result.conflicts, ['pa']); assert.deepEqual(result.repaired, ['sy']);
  assert.equal(fs.readFileSync(path.join(bin, 'pa'), 'utf8'), foreign);
  const cli = spawnSync(process.execPath, [path.join(target, 'scripts/command-shortcuts.mjs'), target, bin], { encoding: 'utf8' });
  assert.equal(cli.status, 1); assert.deepEqual(JSON.parse(cli.stdout).conflicts, ['pa']);
}));

test('symlinks, directories and another PanelArk installation are never overwritten', () => fixture((directory, target, bin) => {
  fs.mkdirSync(bin); fs.mkdirSync(path.join(bin, 'pa'));
  const other = shortcutContent(path.join(directory, 'different-app'));
  fs.writeFileSync(path.join(bin, 'sy'), other);
  assert.deepEqual(repairCommandShortcuts({ targetDirectory: target, shortcutDirectory: bin }).conflicts, ['pa', 'sy']);
  assert.ok(fs.statSync(path.join(bin, 'pa')).isDirectory()); assert.equal(fs.readFileSync(path.join(bin, 'sy'), 'utf8'), other);
  if (process.platform !== 'win32') {
    fs.rmSync(path.join(bin, 'pa'), { recursive: true });
    const foreign = path.join(directory, 'foreign'); fs.writeFileSync(foreign, 'KEEP'); fs.symlinkSync(foreign, path.join(bin, 'pa'));
    assert.deepEqual(repairCommandShortcuts({ targetDirectory: target, shortcutDirectory: bin }).conflicts, ['pa', 'sy']);
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'KEEP'); assert.ok(fs.lstatSync(path.join(bin, 'pa')).isSymbolicLink());
    fs.unlinkSync(path.join(bin, 'pa')); fs.symlinkSync(path.join(directory, 'missing'), path.join(bin, 'pa'));
    assert.deepEqual(repairCommandShortcuts({ targetDirectory: target, shortcutDirectory: bin }).conflicts, ['pa', 'sy']);
  }
}));

test('legacy managed commands migrate and executable permissions are restored', () => fixture((_directory, target, bin) => {
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pa'), `#!/usr/bin/env bash\n# PanelArk managed shortcut\nif [ -f "${target}/install.sh" ]; then\n  exec bash "${target}/install.sh" "$@"\nelse\n  echo "[ERROR] 部署助手脚本文件未找到，请重新运行一键安装命令！"\n  exit 1\nfi\n`);
  fs.writeFileSync(path.join(bin, 'sy'), shortcutContent(target), { mode: 0o600 });
  const result = repairCommandShortcuts({ targetDirectory: target, shortcutDirectory: bin });
  assert.deepEqual(result.repaired, ['pa', 'sy']);
  assert.equal(fs.readFileSync(path.join(bin, 'pa'), 'utf8'), shortcutContent(target));
  if (process.platform !== 'win32') for (const name of ['pa', 'sy']) assert.equal(fs.statSync(path.join(bin, name)).mode & 0o777, 0o755);
}));

test('production standalone startup executes the packaged repair tool and survives conflicts', () => fixture((_directory, target, bin) => {
  const warnings: string[] = [];
  const options = { targetDirectory: target, shortcutDirectory: bin, platform: 'linux' as const, uid: 0, mode: 'standalone', production: true, warn: (text: string) => warnings.push(text) };
  assert.deepEqual(ensureStandaloneShortcuts(options), { skipped: false, ok: true });
  assert.ok(fs.existsSync(path.join(bin, 'pa'))); assert.deepEqual(warnings, []);
  fs.writeFileSync(path.join(bin, 'pa'), 'FOREIGN'); fs.unlinkSync(path.join(bin, 'sy'));
  assert.deepEqual(ensureStandaloneShortcuts(options), { skipped: false, ok: false });
  assert.equal(fs.readFileSync(path.join(bin, 'pa'), 'utf8'), 'FOREIGN'); assert.ok(fs.existsSync(path.join(bin, 'sy')));
  assert.match(warnings[0], /网站继续启动/);
}));

test('panel, Docker, development, Windows and non-root startup never create host commands', () => fixture((_directory, target, bin) => {
  const base = { targetDirectory: target, shortcutDirectory: bin, platform: 'linux' as NodeJS.Platform, uid: 0, mode: 'standalone', production: true };
  for (const change of [{ mode: 'panel' }, { mode: 'docker' }, { mode: '' }, { production: false }, { platform: 'win32' as const }, { uid: 1000 }]) {
    assert.deepEqual(ensureStandaloneShortcuts({ ...base, ...change }), { skipped: true });
    assert.equal(fs.existsSync(bin), false);
  }
}));

test('missing helpers fail nonfatally and invalid source paths never create command files', () => fixture((_directory, target, bin) => {
  fs.unlinkSync(path.join(target, 'scripts/command-shortcuts.mjs'));
  const warnings: string[] = [];
  assert.deepEqual(ensureStandaloneShortcuts({ targetDirectory: target, shortcutDirectory: bin, platform: 'linux', uid: 0, mode: 'standalone', production: true, warn: text => warnings.push(text) }), { skipped: false, ok: false });
  assert.equal(warnings.length, 1); assert.equal(fs.existsSync(bin), false);
  assert.throws(() => repairCommandShortcuts({ targetDirectory: 'relative', shortcutDirectory: bin }));
  fs.unlinkSync(path.join(target, 'install.sh'));
  assert.throws(() => repairCommandShortcuts({ targetDirectory: target, shortcutDirectory: bin }));
  assert.equal(fs.existsSync(bin), false);
}));

const shellTest = process.platform === 'win32' && !process.env.PANELARK_TEST_BASH ? test.skip : test;
shellTest('generated shortcuts really invoke menu by default and forward subcommands including quoted paths', () => fixture((_directory, target, bin) => {
  const quotedTarget = `${target} 'quoted'`;
  fs.renameSync(target, quotedTarget);
  repairCommandShortcuts({ targetDirectory: quotedTarget, shortcutDirectory: bin });
  const bashPath = (value: string) => process.platform === 'win32' ? value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`) : value;
  for (const [name, args] of [['pa', []], ['sy', ['logs']], ['pa', ['status', 'two words']]] as const) {
    const result = spawnSync(process.env.PANELARK_TEST_BASH || 'bash', [bashPath(path.join(bin, name)), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MENU_ACTION/);
    for (const arg of args) assert.ok(result.stdout.includes(`<${arg}>`));
  }
}));
