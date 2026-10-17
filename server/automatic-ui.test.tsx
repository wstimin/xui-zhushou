import assert from 'node:assert/strict';
import test from 'node:test';
import { act, StrictMode } from 'react';
import { JSDOM } from 'jsdom';
import { AutomaticDeploymentModal, AutomaticServerModal } from '../src/panelark/automatic-ui.js';
import { panels } from '../src/panelark/catalog.js';
import type { ActiveServer } from '../src/panelark/types.js';
import { deploymentGuidance } from '../src/panelark/deployment-guidance.js';

test('automatic UI connects without confirmation, starts once, does not restore delivery on refresh and closes only by explicit action', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const before = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key as keyof typeof dom.window] });
  const originalFetch = globalThis.fetch;
  const requests: { path: string; body: any }[] = [];
  const environment = { targetHost: 'example.test', sshPort: 22, compatibility: { compatible: true, reasons: [] } };
  let connected: ActiveServer | undefined, closeCount = 0;
  globalThis.fetch = async (url, options) => {
    const path = String(url), body = options?.body ? JSON.parse(String(options.body)) : undefined; requests.push({ path, body });
    const data = path.endsWith('/connect') ? { serverSessionId: 'session', fingerprint: 'SHA256:test' }
      : path.endsWith('/inspect') ? { details: environment }
      : path === '/api/deployment/current' && (options?.headers as Record<string, string>)?.['x-panelark-delivery'] === 'page-only-secret' ? { job: { id: 'job', status: 'succeeded', progress: 100, payload: { adapterId: 'new-api' }, steps: [] }, usage: { totalUses: 5, usedCount: 1, remaining: 4, lockedCount: 0 }, result: { username: 'real-admin', password: 'real-result-password', accessUrl: 'http://example.test:3000' } }
      : path === '/api/jobs' ? { job: { id: 'job' }, receipt: 'page-only-secret' } : {};
    return new Response(JSON.stringify({ success: true, ...data }), { headers: { 'content-type': 'application/json' } });
  };
  const { createRoot } = await import('react-dom/client'); const root = createRoot(dom.window.document.getElementById('root')!);
  const document = dom.window.document;
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const click = async (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label); assert.ok(button, label);
    await act(async () => button.click()); await settle();
  };
  try {
    await act(async () => root.render(<AutomaticServerModal grantToken="grant" draft={{ host: 'example.test', port: '22', username: 'root', authType: 'password', password: 'test-ssh', privateKey: '' }} onDraftChange={() => {}} onClose={() => closeCount++} onConnected={server => { connected = server; }} />));
    await click('连接并选择面板'); assert.ok(connected); assert.equal(requests.filter(item => item.path.endsWith('/inspect')).length, 1);
    assert.equal(requests.find(item => item.path.endsWith('/inspect'))?.body.fingerprint, 'SHA256:test');
    assert.doesNotMatch(document.body.textContent!, /确认指纹|我已检查|提前安装 Docker/);
    await act(async () => root.render(<StrictMode><AutomaticDeploymentModal item={panels.find(item => item.id === 'new-api')!} server={connected} grantToken="grant" onConsumed={() => {}} onClose={() => closeCount++} onToast={() => {}} /></StrictMode>)); await settle();
    assert.equal(requests.filter(item => item.path === '/api/jobs').length, 1, 'Strict Mode must not create duplicate installations');
    assert.equal(requests.find(item => item.path === '/api/jobs')?.body.payload.autoDeploy, true);
    assert.match(document.body.textContent!, /real-result-password/);
    assert.match(document.body.textContent!, /不会自动关闭/);
    await act(async () => { document.querySelector('.modal-backdrop')!.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })); document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(closeCount, 0); assert.equal(requests.some(item => item.path.endsWith('/acknowledge')), false);
    assert.match(document.body.textContent!, /刷新或离开页面后不可重新查看/);
    assert.match(document.body.textContent!, /CDK 总次数 5 · 已用 1 · 剩余 4 次/);
    assert.equal(dom.window.localStorage.length, 0); assert.equal(dom.window.sessionStorage.length, 0); assert.equal(document.cookie, '');
    await click('我已保存，关闭结果');
    assert.equal(closeCount, 1); assert.equal(requests.filter(item => item.path.endsWith('/acknowledge')).length, 1);
    await act(async () => root.render(<div />));
    const pollCount = requests.filter(item => item.path === '/api/deployment/current').length;
    await act(async () => root.render(<AutomaticDeploymentModal onClose={() => closeCount++} onToast={() => {}} />)); await settle();
    assert.doesNotMatch(document.body.textContent!, /real-result-password/);
    assert.equal(requests.filter(item => item.path === '/api/deployment/current').length, pollCount, 'refresh cannot read the previous receipt');
    assert.ok(deploymentGuidance('端口 80 被占用').some(item => item.includes('不会停止')));
    assert.ok(deploymentGuidance('SSH 认证失败').some(item => item.includes('密码')));
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = originalFetch; dom.window.close();
    for (const key of keys) { const descriptor = before.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; }
  }
});
