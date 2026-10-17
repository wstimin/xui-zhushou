import assert from 'node:assert/strict';
import test from 'node:test';
import { act } from 'react';
import { JSDOM } from 'jsdom';
import { CdkCodesDialog, CdkManagementTable } from '../src/admin/CdkManagement.js';
import { AdminDialogProvider } from '../src/admin/dialog.js';

test('CDK management UI reveals, copies, exports, edits and confirms single and bulk deletion', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/admin' });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const before = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key as keyof typeof dom.window] });
  const originalFetch = globalThis.fetch, originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const requests: { path: string; method: string; body: any }[] = [], notices: string[] = [], downloads: Blob[] = [], copies: string[] = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (text: string) => { copies.push(text); } }, configurable: true });
  URL.createObjectURL = (blob: Blob) => { downloads.push(blob); return 'blob:test-cdk'; }; URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  const notify = (notice: { text: string } | null) => { if (notice) notices.push(notice.text); };
  let items = [
    { id: 'cdk-new', code_hint: '…AAAA', package_id: 'pkg', package_name: '五次套餐', batch_id: 'batch', batch_name: '测试批次', used_count: 0, max_uses: 5, status: 'active', code_available: 1, locked_count: 0 },
    { id: 'cdk-old', code_hint: '…BBBB', package_id: 'pkg', package_name: '五次套餐', batch_id: 'batch', batch_name: '测试批次', used_count: 1, max_uses: 5, status: 'active', code_available: 0, locked_count: 0 },
  ];
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url), 'http://localhost'); const path = target.pathname.replace('/api/admin', ''), method = options?.method || 'GET';
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    requests.push({ path, method, body }); let result: any = {};
    const paging = (rows: unknown[]) => ({ items: rows, pagination: { page: 1, pageSize: 20, total: rows.length, totalPages: 1 } });
    if (path === '/packages') result = paging([{ id: 'pkg', name: '五次套餐', enabled: 1 }]);
    else if (path === '/batches') result = paging([{ id: 'batch', name: '测试批次' }]);
    else if (path === '/cdks' && method === 'GET') result = paging(items);
    else if (path.endsWith('/reveal')) result = { code: 'PAK-AAAA-AAAA-AAAA' };
    else if (path === '/cdks/export') result = { filename: 'cdks.txt', mime: 'text/plain', content: 'PAK-AAAA-AAAA-AAAA\n', total: 2, exported: 1, unavailable: 1 };
    else if (method === 'PATCH') items = items.map(item => item.id === 'cdk-new' ? { ...item, max_uses: body.maxUses } : item);
    else if (method === 'DELETE') { items = items.filter(item => !path.endsWith(item.id)); result = { affected: 1 }; }
    else if (path === '/cdks/bulk') { if (body.action === 'delete') items = items.filter(item => !body.ids.includes(item.id)); else items = items.map(item => body.ids.includes(item.id) ? { ...item, status: body.status } : item); result = { affected: body.ids.length }; }
    return new Response(JSON.stringify({ success: true, ...result }), { headers: { 'content-type': 'application/json' } });
  };
  const { createRoot } = await import('react-dom/client'); const root = createRoot(dom.window.document.getElementById('root')!);
  const document = dom.window.document;
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const click = async (label: string, scope: ParentNode = document) => {
    let button = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === label);
    if (!button) {
      const more=[...scope.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent?.trim()==='更多');
      if(more){await act(async()=>more.click());await settle();button=[...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(button=>button.textContent?.trim()===label);}
    }
    assert.ok(button, label); assert.equal(button.disabled, false, label); await act(async () => button.click()); await settle();
  };
  const row = () => document.querySelector('tbody tr')!;
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
  try {
    await act(async () => root.render(<AdminDialogProvider><CdkManagementTable admin={{ id: 'owner', username: 'owner', role: 'super_admin' }} notify={notify} refreshKey={0} /></AdminDialogProvider>)); await settle();
    assert.equal(document.querySelectorAll('tbody tr').length, 2);
    assert.doesNotMatch(document.body.textContent!, /明文只显示一次/);
    await click('查看', row()); assert.match(row().textContent!, /PAK-AAAA-AAAA-AAAA/);
    await click('隐藏', row()); assert.doesNotMatch(row().textContent!, /PAK-AAAA-AAAA-AAAA/);
    await click('复制', row()); assert.equal(copies.at(-1), 'PAK-AAAA-AAAA-AAAA');
    // The user's HTTP deployment has no secure-context Clipboard API.
    Object.defineProperty(dom.window.navigator, 'clipboard', { value: undefined, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: (command: string) => { assert.equal(command, 'copy'); copies.push(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="复制 CDK"]')!.value); return true; }, configurable: true });
    await click('复制', row()); assert.equal(copies.at(-1), 'PAK-AAAA-AAAA-AAAA');
    await click('导出全部筛选结果'); assert.equal(await downloads[0].text(), 'PAK-AAAA-AAAA-AAAA\n');
    assert.equal(requests.find(item => item.path === '/cdks/export')?.body.scope, 'filtered');
    assert.match(notices.at(-1)!, /旧版哈希无法还原/);
    await click('编辑', row()); assert.equal(dialog().getAttribute('aria-modal'), 'true');
    const quota = [...dialog().querySelectorAll('label')].find(label => label.textContent?.includes('总使用次数'))!.querySelector('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(quota, '9'); quota.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await click('保存修改', dialog()); assert.match(row().textContent!, /0\/9/);
    await act(async () => document.querySelector<HTMLInputElement>('input[aria-label="选择当前页全部 CDK"]')!.click()); await settle();
    await click('批量停用'); await click('确认', dialog());
    assert.deepEqual(requests.filter(item => item.path === '/cdks/bulk').at(-1)?.body.ids, ['cdk-new', 'cdk-old']);
    assert.ok([...document.querySelectorAll('tbody tr')].every(row => row.textContent?.includes('停用')));
    await click('删除', row()); assert.match(dialog().textContent!, /永久删除/); await click('取消', dialog());
    assert.equal(requests.filter(item => item.method === 'DELETE').length, 0);
    await click('删除', row()); await click('确认', dialog()); assert.equal(document.querySelectorAll('tbody tr').length, 1);
    const selectAll = document.querySelector<HTMLInputElement>('input[aria-label="选择当前页全部 CDK"]')!;
    await act(async () => selectAll.click()); await settle();
    await click('批量删除'); await click('确认', dialog()); assert.equal(document.querySelectorAll('tbody tr').length, 0);
    assert.equal(requests.filter(item => item.method === 'DELETE').length, 2, 'bulk deletion of one selected row still deletes that row');

    await act(async () => root.render(<AdminDialogProvider><CdkCodesDialog codes={['PAK-ONE', 'PAK-TWO']} onClose={() => {}} notify={notify} /></AdminDialogProvider>)); await settle();
    assert.equal(document.querySelector('textarea')!.value, 'PAK-ONE\nPAK-TWO');
    await click('下载 TXT'); assert.equal(await downloads.at(-1)!.text(), 'PAK-ONE\nPAK-TWO\n');
    await act(async () => root.render(<AdminDialogProvider><CdkManagementTable admin={{ id: 'support', username: 'support', role: 'support' }} notify={notify} refreshKey={0} /></AdminDialogProvider>)); await settle();
    assert.doesNotMatch(document.body.textContent!, /导出全部筛选结果|批量删除/);
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = originalFetch; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; dom.window.close();
    for (const key of keys) { const descriptor = before.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; }
  }
});
