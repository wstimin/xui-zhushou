import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { mountPanelArkApi } from './panelark-api.js';

test('admin pages drive real HTTP and database CRUD, including task after-sales', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panelark-admin-ui-'));
  const envKeys = ['PANELARK_DATA_DIR', 'PANELARK_DEPLOYMENT_MODE', 'PANELARK_SETUP_TOKEN'] as const, savedEnv = envKeys.map(key => process.env[key]);
  process.env.PANELARK_DATA_DIR = directory; process.env.PANELARK_DEPLOYMENT_MODE = 'panel'; process.env.PANELARK_SETUP_TOKEN = 'test-setup-token';
  const app = express(); app.use(express.json()); const { db, jobEngine } = await mountPanelArkApi(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fetchOriginal = globalThis.fetch;
  const bootResponse = await fetchOriginal(base + '/api/admin/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'test-setup-token', username: 'owner', password: '123456' }) });
  const cookie = bootResponse.headers.get('set-cookie')!.split(';')[0];
  const job = jobEngine.createJob({ kind: 'new-api', serverKey: 'ui-test-server', steps: [{ key: 'check', title: '环境检测' }] });
  db.run("UPDATE deployment_jobs SET status='failed',error_message='测试故障：无法下载依赖' WHERE id=?", [job.id]);
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: base + '/admin' });
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const before = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key as keyof typeof dom.window] });
  globalThis.fetch = (url, options) => { const headers = new Headers(options?.headers); headers.set('cookie', cookie); return fetchOriginal(new URL(String(url), base), { ...options, headers }); };
  const { createRoot } = await import('react-dom/client'); const { default: AdminApp } = await import('../src/admin/AdminApp.js');
  const root = createRoot(dom.window.document.getElementById('root')!), document = dom.window.document;
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); }); };
  const waitFor = async (condition: () => boolean) => { for (let i = 0; i < 100 && !condition(); i++) await settle(); assert.ok(condition(), document.body.textContent?.slice(-1500)); };
  const dialog = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!;
  const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label);
  const click = async (label: string, scope: ParentNode = document) => {
    let node = button(label, scope);
    if (!node && button('更多',scope)) { await act(async()=>button('更多',scope)!.click()); await settle(); node=button(label,document.querySelector('[role="menu"]')!); }
    assert.ok(node, `button ${label} exists`); assert.equal(node.disabled, false, label); await act(async () => node.click()); await settle();
  };
  const dismiss = async () => { await waitFor(() => Boolean(button('知道了', dialog()))); await click('知道了', dialog()); };
  const fill = async (label: string, value: string, scope: ParentNode = dialog()) => {
    const field = [...scope.querySelectorAll('label')].find(node => node.querySelector('span')?.textContent === label)?.querySelector('input,select') as HTMLInputElement | HTMLSelectElement;
    assert.ok(field, label);
    await act(async () => { if (field.tagName === 'SELECT') { field.value = value; field.dispatchEvent(new dom.window.Event('change', { bubbles: true })); } else { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new dom.window.Event('input', { bubbles: true })); } });
  };
  const prompt = async (value: string) => { const field = dialog().querySelector('input')!; await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); await click('确认', dialog()); };
  try {
    await act(async () => root.render(<AdminApp />)); await waitFor(() => Boolean(button('任务售后')));
    await click('任务售后'); await waitFor(() => Boolean(button('详情与处理记录')));
    await click('详情与处理记录'); await waitFor(() => document.body.textContent!.includes('测试故障：无法下载依赖'));
    assert.match(dialog().textContent!, /环境检测/);
    await click('新增处理记录', dialog()); await prompt('已检查依赖下载网络'); await dismiss();
    assert.equal(db.get('SELECT note FROM job_notes WHERE job_id=?', [job.id])!.note, '已检查依赖下载网络');
    await click('修改记录', dialog()); await prompt('已修复网络并通知用户'); await dismiss(); assert.equal(db.get('SELECT note FROM job_notes WHERE job_id=?', [job.id])!.note, '已修复网络并通知用户');
    await click('编辑审核', dialog()); await fill('审核备注', '等待用户确认'); await fill('处理状态', 'reviewed'); await click('保存', dialog()); await dismiss();
    assert.equal(db.get('SELECT status FROM job_reviews WHERE job_id=?', [job.id])!.status, 'reviewed');
    await click('删除记录', dialog()); await click('取消', dialog()); assert.ok(db.get('SELECT id FROM job_notes WHERE job_id=?', [job.id]));
    await click('删除记录', dialog()); await click('确认', dialog()); await dismiss(); assert.equal(db.get('SELECT id FROM job_notes WHERE job_id=?', [job.id]), undefined);
    await act(async () => dialog().querySelector<HTMLButtonElement>('[aria-label="关闭弹窗"]')!.click());
    await click('删除任务'); await click('确认', dialog()); await dismiss(); assert.equal(db.get('SELECT id FROM deployment_jobs WHERE id=?', [job.id]), undefined);

    await click('管理员'); await waitFor(() => Boolean(button('创建账号'))); await click('创建账号'); await fill('用户名', 'managed-admin'); await fill('初始密码（至少 6 位）', '123456'); await fill('角色', 'support'); await click('保存', dialog()); await dismiss();
    let row = [...document.querySelectorAll('tbody tr')].find(node => node.textContent?.includes('managed-admin'))!; assert.ok(row);
    await click('编辑账号', row); await fill('用户名', 'renamed-admin'); await fill('角色', 'operator'); await click('保存', dialog()); await dismiss();
    assert.equal(db.get("SELECT role FROM admins WHERE username='renamed-admin'")!.role, 'operator');
    row = [...document.querySelectorAll('tbody tr')].find(node => node.textContent?.includes('renamed-admin'))!; await click('删除账号', row); await click('确认', dialog()); await dismiss(); assert.equal(db.get("SELECT id FROM admins WHERE username='renamed-admin'"), undefined);

    await click('资源推荐'); await click('新增推荐'); await fill('标题', '部署资源'); await fill('说明', '测试说明'); await fill('标签', '优选'); await fill('HTTPS 链接', 'http://invalid.example.test'); await fill('排序（0—10000）', '0'); await click('保存', dialog()); await dismiss();
    assert.equal(db.get("SELECT id FROM recommended_resources WHERE title='部署资源'"), undefined);
    assert.equal(dialog().querySelector<HTMLInputElement>('input')!.value, '部署资源', 'failed saves keep the editor and entered data');
    await fill('HTTPS 链接', 'https://example.test'); await click('保存', dialog()); await dismiss();
    const resource = db.get("SELECT * FROM recommended_resources WHERE title='部署资源'")!; assert.equal(resource.sort_order, 0); assert.equal(resource.badge, '优选');
    await click('编辑推荐'); await fill('类型', 'domain'); await fill('说明', '修改后的说明'); await click('保存', dialog()); await dismiss(); assert.equal(db.get('SELECT description FROM recommended_resources WHERE id=?', [resource.id])!.description, '修改后的说明');
    await click('删除'); await click('确认', dialog()); await dismiss(); assert.equal(db.get('SELECT id FROM recommended_resources WHERE id=?', [resource.id]), undefined);

    await click('CDK 管理'); await click('套餐管理'); await waitFor(() => Boolean(button('编辑套餐'))); await click('编辑套餐'); await fill('套餐名称', '正式套餐'); await fill('最多部署次数', '8'); await fill('有效天数（0 为永久）', '0'); await click('保存', dialog()); await dismiss(); assert.equal(db.get("SELECT max_uses FROM cdk_packages WHERE name='正式套餐'")!.max_uses, 8);
    await click('目录运营'); await waitFor(() => Boolean(button('编辑项目'))); const item = db.get('SELECT adapter_id FROM catalog_overrides LIMIT 1'); assert.equal(item, undefined);
    await click('编辑项目'); await fill('项目名称', '正式展示名称'); await fill('排序（0—10000）', '0'); await click('保存', dialog()); await dismiss(); assert.equal(db.get("SELECT sort_order FROM catalog_overrides WHERE name='正式展示名称'")!.sort_order, 0);

    await click('备份迁移'); await waitFor(() => Boolean(button('创建手动备份'))); await click('创建手动备份'); await prompt('123456'); await dismiss();
    await click('修改备注'); await prompt('上线前备份'); await dismiss(); assert.equal(db.get('SELECT label FROM backup_records LIMIT 1')!.label, '上线前备份');
    await click('删除备份'); await click('确认', dialog()); await dismiss(); assert.equal(db.get('SELECT id FROM backup_records LIMIT 1'), undefined);
    await click('审计日志'); await waitFor(() => Boolean(button('查看详情'))); await click('查看详情'); assert.equal(dialog().getAttribute('aria-modal'), 'true'); await dismiss();
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = fetchOriginal; dom.window.close(); for (const key of globals) { const descriptor = before.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as any)[key]; }
    await new Promise<void>(resolve => server.close(() => resolve())); db.close(); fs.rmSync(directory, { recursive: true, force: true }); envKeys.forEach((key, i) => { if (savedEnv[i] === undefined) delete process.env[key]; else process.env[key] = savedEnv[i]; });
  }
});
