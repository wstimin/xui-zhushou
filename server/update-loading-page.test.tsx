import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';

test('update page distinguishes pending, missing keys and failed reads across navigation', async t => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/admin' });
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const before = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key as keyof typeof dom.window] });
  const originalFetch = globalThis.fetch;
  type Pending = { resolve: (value: Response) => void; reject: (error: Error) => void; signal?: AbortSignal | null };
  const statuses: Pending[] = [], reports: Pending[] = [];
  const mutations: string[] = [];
  const response = (value: object) => new Response(JSON.stringify({ success: true, ...value }), { headers: { 'content-type': 'application/json' } });
  const status = (signingConfigured = true) => ({ signingConfigured, adapterCatalogVersion: '9.0.0', applicationUpdateSupported: true, applicationUpdateHint: '', state: { phase: 'idle', progress: 0, currentVersion: '9.0.0', channel: 'stable', message: '尚未检查更新', events: [] } });
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url), 'http://localhost').pathname.replace('/api/admin', '');
    if (options?.method && options.method !== 'GET') mutations.push(path);
    if (path === '/update/status' || path === '/security/report') return new Promise<Response>((resolve, reject) => (path === '/update/status' ? statuses : reports).push({ resolve, reject, signal: options?.signal }));
    return response(path === '/bootstrap' ? { required: false } : path === '/session' ? { admin: { id: 'owner', username: 'owner', role: 'super_admin' } } : { stats: {} });
  };
  const { createRoot } = await import('react-dom/client');
  const { default: AdminApp } = await import('../src/admin/AdminApp.js');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const document = dom.window.document;
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const click = async (text: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text);
    assert.ok(button, text); assert.equal(button.disabled, false, text);
    await act(async () => button.click()); await settle();
  };
  const stat = (label: string) => [...document.querySelectorAll('.admin-stat')].find(item => item.querySelector('small')?.textContent === label)?.querySelector('strong')?.textContent;
  const check = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '检测更新')!;
  const noKeyWarning = () => assert.doesNotMatch(document.body.textContent!, /未找到正式发布签名公钥|PANELARK_UPDATE_PUBLIC_KEY|未配置/);
  const resolveStatus = async (index: number, configured = true) => { await act(async () => statuses[index].resolve(response(status(configured)))); await settle(); };
  try {
    await act(async () => root.render(<AdminApp />)); await settle();
    await t.test('first entry stays neutral and slow security checks do not block valid status', async () => {
      await click('系统更新');
      noKeyWarning(); assert.equal(stat('签名状态'), '读取中'); assert.equal(check().disabled, true);
      await click('暗色模式'); noKeyWarning(); assert.equal(document.documentElement.dataset.theme, 'dark');
      await click('浅色模式'); noKeyWarning(); assert.equal(document.documentElement.dataset.theme, 'light');
      assert.equal(document.querySelector('.progress-track.large'), null);
      await resolveStatus(0);
      assert.equal(stat('当前版本'), '9.0.0'); assert.equal(stat('签名状态'), '可信'); assert.equal(stat('适配器目录'), '9.0.0');
      assert.equal(check().disabled, false); noKeyWarning();
      assert.equal(reports.length, 1); // Deliberately still pending.
    });
    await t.test('leaving and reentering aborts old reads and ignores late results', async () => {
      await click('业务概览'); assert.equal(statuses[0].signal?.aborted, true); assert.equal(reports[0].signal?.aborted, true);
      await click('系统更新'); noKeyWarning(); assert.equal(stat('签名状态'), '读取中');
      await click('业务概览'); await click('系统更新');
      await resolveStatus(1, false);
      await act(async () => reports[0].resolve(response({ report: { failed: 99, warnings: 0, checks: [] } })));
      noKeyWarning(); assert.equal(stat('签名状态'), '读取中');
      await resolveStatus(2); assert.equal(stat('签名状态'), '可信');
    });
    await t.test('only an explicit negative status shows the missing-key warning', async () => {
      await click('业务概览'); await click('系统更新'); noKeyWarning();
      await resolveStatus(3, false);
      assert.match(document.body.textContent!, /未找到正式发布签名公钥/); assert.equal(stat('签名状态'), '未配置'); assert.equal(check().disabled, true);
      await act(async () => reports[3].reject(new Error('安全报告暂不可用'))); await settle();
      assert.match(document.body.textContent!, /安全报告暂不可用/); assert.equal(stat('当前版本'), '9.0.0');
    });
    await t.test('failed status is not a missing key; refresh retries and recovers', async () => {
      await click('业务概览'); await click('系统更新');
      await act(async () => statuses[4].reject(new Error('更新状态接口暂不可用'))); await settle();
      noKeyWarning(); assert.equal(stat('签名状态'), '读取失败'); assert.match(document.body.textContent!, /更新状态接口暂不可用/); assert.equal(check().disabled, true);
      await click('刷新状态'); noKeyWarning(); assert.equal(stat('签名状态'), '读取中');
      await resolveStatus(5); noKeyWarning(); assert.equal(stat('签名状态'), '可信'); assert.equal(check().disabled, false);
      assert.doesNotMatch(document.body.textContent!, /更新状态接口暂不可用/);
      await act(async () => reports[5].resolve(response({ report: { failed: 0, warnings: 0, checks: [] } }))); await settle();
      assert.match(document.body.textContent!, /0 项失败/);
    });
    await t.test('timeouts are bounded, retryable and do not masquerade as missing keys', async () => {
      await click('业务概览');
      const originalTimeout = dom.window.setTimeout.bind(dom.window);
      const timeouts: (() => void)[] = [];
      dom.window.setTimeout = ((callback: () => void, delay?: number) => {
        if (delay === 15000) { timeouts.push(callback); return originalTimeout(() => {}, 60000); }
        return originalTimeout(callback, delay);
      }) as typeof dom.window.setTimeout;
      try {
        await click('系统更新'); noKeyWarning();
        for (const pending of [statuses[6], reports[6]]) pending.signal!.addEventListener('abort', () => pending.reject(new Error('aborted')), { once: true });
        assert.equal(timeouts.length, 2);
        await act(async () => timeouts.forEach(callback => callback())); await settle();
        assert.equal(statuses[6].signal!.aborted, true); assert.equal(reports[6].signal!.aborted, true);
        noKeyWarning(); assert.equal(stat('签名状态'), '读取失败'); assert.match(document.body.textContent!, /读取更新状态超时/);
        assert.match(document.body.textContent!, /读取安全报告超时/); assert.equal(check().disabled, true);
      } finally { dom.window.setTimeout = originalTimeout; }
      await click('刷新状态'); await resolveStatus(7); noKeyWarning(); assert.equal(check().disabled, false);
    });
    assert.deepEqual(mutations, [], 'navigation and refresh must never check, download or apply an update');
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = originalFetch; dom.window.close();
    for (const key of globals) { const descriptor = before.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
