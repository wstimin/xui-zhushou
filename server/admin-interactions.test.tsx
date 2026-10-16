import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';

test('admin pagination, centered dialogs, cancellation, manual updates and theme switching work together', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/admin' });
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const before = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key as keyof typeof dom.window] });
  const originalFetch = globalThis.fetch;
  const requests: { path: string; method: string; body: unknown }[] = [];
  let phase = 'idle';
  let savedSettings = { purchaseEnabled: true, purchaseButtonText: '购买 CDK', purchaseUrl: 'https://old-shop.example/cdk', supportUrl: 'https://support.example/', siteNotice: '', adminPath: '/admin' };
  const state = () => ({ phase, progress: 0, currentVersion: '2.2.3', channel: 'stable', targetVersion: '99.0.0', message: '测试版本信息', updatedAt: new Date().toISOString(), events: [] });
  const identity = { id: 'owner', username: 'owner', role: 'super_admin' };
  const { createRoot } = await import('react-dom/client');
  const { default: AdminApp } = await import('../src/admin/AdminApp.js');
  const root = createRoot(dom.window.document.getElementById('root')!);
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url), 'http://localhost');
    const path = target.pathname.replace('/api/admin', '');
    const method = options?.method || 'GET';
    requests.push({ path, method, body: options?.body ? JSON.parse(String(options.body)) : null });
    let result: unknown;
    if (path === '/bootstrap') result = { required: false };
    else if (path === '/session') result = { admin: identity };
    else if (path === '/dashboard') result = { stats: {} };
    else if (path === '/settings') {
      assert.equal(options?.cache, 'no-store');
      if (method === 'PUT') savedSettings = JSON.parse(String(options.body));
      result = savedSettings;
    }
    else if (path === '/update/status') result = { state: state(), signingConfigured: true, applicationUpdateSupported: true, adapterCatalogVersion: '2.2.3' };
    else if (path === '/security/report') result = { report: { failed: 0, warnings: 0, checks: [] } };
    else if (path === '/update/check') { phase = 'available'; result = { state: state() }; }
    else if (path === '/update/prepare') { phase = 'prepared'; result = { state: state() }; }
    else if (path === '/update/apply') { phase = 'completed'; result = { state: state() }; }
    else if (method === 'GET' && ['/jobs', '/resources', '/backups'].includes(path)) {
      const pageSize = Number(target.searchParams.get('pageSize') || 20), page = Number(target.searchParams.get('page') || 1);
      const items = path === '/jobs' ? Array.from({ length: Math.min(pageSize, 23 - (page - 1) * pageSize) }, (_, index) => ({ id: `job${(page - 1) * pageSize + index}`, kind: 'test', status: 'failed', progress: 0, task_key: 'test' })) : path === '/resources' ? [{ id: 'resource', title: '测试资源', enabled: 1, url: 'https://example.test', click_count: 0 }] : [{ id: 'backup', filename: 'test.pgbak', created_at: new Date().toISOString(), size_bytes: 1024 }];
      result = { items, pagination: { page, pageSize, total: path === '/jobs' ? 23 : 1, totalPages: path === '/jobs' ? Math.ceil(23 / pageSize) : 1 } };
    } else result = {};
    return new Response(JSON.stringify({ success: true, ...result as object }), { headers: { 'content-type': 'application/json' } });
  };
  const document = dom.window.document;
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const click = async (text: string, scope: ParentNode = document) => {
    const button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text);
    assert.ok(button, `button ${text} exists`); assert.equal(button.disabled, false, text);
    await act(async () => { button.click(); }); await settle();
  };
  const dialog = () => { const node = document.querySelector<HTMLElement>('[role="dialog"]'); assert.ok(node); assert.equal(node.getAttribute('aria-modal'), 'true'); assert.equal(node.parentElement?.parentElement, document.body); return node; };
  const dismiss = () => click('知道了', dialog());
  const updates = () => requests.filter(item => ['/update/prepare', '/update/apply'].includes(item.path));
  try {
    await act(async () => { root.render(<AdminApp />); }); await settle();
    assert.equal(document.documentElement.dataset.theme, 'light');
    await click('暗色模式'); assert.equal(document.documentElement.dataset.theme, 'dark'); assert.equal(dom.window.localStorage.getItem('panelark-theme'), 'dark');
    await click('任务售后');
    assert.equal(document.querySelectorAll('tbody tr').length, 20);
    assert.match(document.querySelector('.admin-pagination')!.textContent!, /共 23 条/);
    await click('下一页'); assert.equal(document.querySelectorAll('tbody tr').length, 3);
    assert.match(document.querySelector('tbody')!.textContent!, /job20/);
    await click('首页'); assert.equal(document.querySelectorAll('tbody tr').length, 20);
    const size = document.querySelector<HTMLSelectElement>('[aria-label="每页条数"]')!;
    await act(async () => { size.value = '10'; size.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); await settle();
    assert.equal(document.querySelectorAll('tbody tr').length, 10);
    await click('审核'); dialog(); assert.equal(document.activeElement?.tagName, 'INPUT');
    await click('取消', dialog()); assert.equal(requests.filter(item => item.method === 'PUT').length, 0);
    await click('审核'); await click('确认', dialog());
    assert.equal(requests.filter(item => item.path.endsWith('/review')).length, 1); await dismiss();
    await click('资源推荐'); await click('删除'); await click('取消', dialog());
    assert.equal(requests.filter(item => item.method === 'DELETE').length, 0);
    await click('备份迁移'); await click('创建手动备份');
    assert.equal(dialog().querySelector('input')?.type, 'password');
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await settle();
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(requests.filter(item => item.path === '/backups' && item.method === 'POST').length, 0);
    await click('系统更新'); await click('检测更新');
    assert.doesNotMatch(document.body.textContent!, /测试通道/);
    assert.deepEqual(requests.find(item => item.path === '/update/check')?.body, { channel: 'stable' });
    assert.match(dialog().textContent!, /检测不会下载或安装/); assert.equal(updates().length, 0); await dismiss();
    await click('下载并安装更新'); assert.equal(dialog().querySelector('input'), null); await click('取消', dialog()); assert.equal(updates().length, 0);
    await click('下载并安装更新'); assert.equal(dialog().querySelector('input'), null); await click('确认', dialog());
    assert.deepEqual(updates().map(item => item.path), ['/update/prepare', '/update/apply']); await dismiss();
    await click('浅色模式'); assert.equal(document.documentElement.dataset.theme, 'light');
    await click('站点配置');
    const fillSetting = async (label: string, value: string) => {
      const field = [...document.querySelectorAll('label')].find(node => node.querySelector('span')?.textContent === label)?.querySelector('input');
      assert.ok(field, label);
      await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    };
    await fillSetting('客服链接（HTTPS，不影响购买 CDK 跳转）', 'https://new-support.example/');
    assert.equal(document.querySelector('[data-saved-purchase]')?.textContent, 'https://old-shop.example/cdk');
    await click('保存配置');
    assert.match(dialog().textContent!, /购买 CDK 跳转：https:\/\/old-shop.example\/cdk/);
    assert.match(dialog().textContent!, /客服链接：https:\/\/new-support.example\//); await dismiss();
    await fillSetting('购买 CDK 的跳转链接（HTTPS）', 'https://new-shop.example/cdk');
    assert.equal(document.querySelector('[data-saved-purchase]')?.textContent, 'https://old-shop.example/cdk');
    assert.match(document.querySelector('[role="status"]')!.textContent!, /购买链接有未保存修改/);
    await click('保存配置'); assert.match(dialog().textContent!, /购买 CDK 跳转：https:\/\/new-shop.example\/cdk/); await dismiss();
    assert.equal(document.querySelector('[data-saved-purchase]')?.textContent, 'https://new-shop.example/cdk');
    assert.equal(document.querySelector('[data-saved-support]')?.textContent, 'https://new-support.example/');
    assert.equal(document.body.style.overflow, ''); assert.equal(Boolean(document.getElementById('root')!.inert), false);
  } finally {
    await act(async () => { root.unmount(); }); globalThis.fetch = originalFetch; dom.window.close();
    for (const key of globals) { const descriptor = before.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
