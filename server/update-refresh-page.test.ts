import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

test('production page executes the complete update UI and navigates exactly once across completion effect changes', async () => {
  const version = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version as string;
  const parts = version.split('.').map(Number); parts[2]++;
  const nextVersion = parts.join('.');
  const compiled = await build({ entryPoints: ['src/main.tsx'], bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"', __PANELARK_BUILD_VERSION__: JSON.stringify(version) } });
  let runtime = version, phase = 'idle', navigationCount = 0;
  const requests: string[] = [], intervals = new Map<number, () => void>(), errors: string[] = [];
  let timerId = 0;
  const console = new VirtualConsole();
  console.on('jsdomError', error => { if (/navigation/.test(error.message)) navigationCount++; else errors.push(error.message); });
  const dom = new JSDOM('<!doctype html><html><body><div id="root" data-panelark-view="admin"></div></body></html>', { url: 'https://panel.example/custom/console', runScripts: 'outside-only', virtualConsole: console, pretendToBeVisual: true });
  const window = dom.window;
  window.scrollTo = () => {};
  window.setInterval = ((callback: () => void) => { intervals.set(++timerId, callback); return timerId; }) as any;
  window.clearInterval = id => { intervals.delete(id); };
  window.fetch = async url => {
    const pathname = new URL(String(url), window.location.href).pathname; requests.push(pathname);
    let response: object;
    const state = () => ({ phase, currentVersion: runtime, targetVersion: nextVersion, channel: 'stable', progress: phase === 'completed' ? 100 : 0, message: phase === 'completed' ? '更新完成' : '测试状态', updatedAt: new Date().toISOString(), events: [] });
    if (pathname === '/api/health') response = { status: 'ok', version: runtime };
    else if (pathname.endsWith('/bootstrap')) response = { required: false };
    else if (pathname.endsWith('/session')) response = { admin: { id: 'owner', username: 'owner', role: 'super_admin' } };
    else if (pathname.endsWith('/dashboard')) response = { stats: {} };
    else if (pathname.endsWith('/security/report')) response = { report: { failed: 0, warnings: 0, checks: [] } };
    else if (pathname.endsWith('/update/check')) { phase = 'available'; response = { state: state() }; }
    else if (pathname.endsWith('/update/prepare')) { phase = 'prepared'; response = { state: state() }; }
    else if (pathname.endsWith('/update/apply')) { phase = 'applying'; response = { state: state() }; }
    else if (pathname.endsWith('/update/status')) response = { state: state(), signingConfigured: true, applicationUpdateSupported: true, adapterCatalogVersion: 'built-in' };
    else response = {};
    return new Response(JSON.stringify({ success: true, ...response }), { headers: { 'content-type': 'application/json' } });
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));
  const click = async (text: string) => {
    const button = [...window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text);
    assert.ok(button, `missing ${text}`); assert.equal(button.disabled, false); button.click(); await settle();
  };
  try {
    window.eval(compiled.outputFiles[0].text); await settle();
    await click('系统更新'); await click('检测更新'); await click('知道了');
    assert.equal(navigationCount, 0, 'metadata detection cannot navigate');
    await click('下载并安装更新'); await click('确认'); await click('知道了');
    assert.equal(navigationCount, 0, 'the running old service cannot cause a premature reload');
    runtime = nextVersion; phase = 'completed';
    // Both the existing status poll and the health probe finish in this tick;
    // React subsequently recreates the effect for the completed phase.
    for (let tick = 0; tick < 4; tick++) { for (const callback of [...intervals.values()]) callback(); await settle(); }
    assert.match(window.document.body.textContent!, /已完成/);
    assert.equal(navigationCount, 1, 'the navigation latch must survive effect cleanup and recreation');
    assert.equal(requests.filter(path => path.endsWith('/update/prepare')).length, 1);
    assert.equal(requests.filter(path => path.endsWith('/update/apply')).length, 1);
    assert.deepEqual(errors, []);
  } finally { dom.window.close(); }
});
