import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import express from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import { act } from 'react';
import { mountPanelArkApi } from './panelark-api.js';
import { PanelArkDatabase } from './panelark-db.js';
import { canonicalManifest, type ReleaseManifest } from './panelark-update.js';
import { totpCode } from './panelark-security.js';

// No browser control and no mocked admin API. UI events call a real listening
// Express server and a real temporary SQLite file. Only release-host downloads
// are controlled; they still undergo real signature/hash verification.
test('super-admin acceptance: every sidebar section executes its business actions and survives page remount', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panelark-admin-acceptance-'));
  const keys = ['PANELARK_DATA_DIR','PANELARK_DEPLOYMENT_MODE','PANELARK_SETUP_TOKEN','PANELARK_BACKUP_PASSPHRASE','PANELARK_UPDATE_PUBLIC_KEY'] as const;
  const savedEnv = keys.map(key => process.env[key]);
  const pair = generateKeyPairSync('ed25519');
  process.env.PANELARK_DATA_DIR = directory; process.env.PANELARK_DEPLOYMENT_MODE = 'panel'; process.env.PANELARK_SETUP_TOKEN = 'acceptance-setup'; process.env.PANELARK_BACKUP_PASSPHRASE = '123456'; process.env.PANELARK_UPDATE_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const app = express(); app.use(express.json()); const { db, jobEngine } = await mountPanelArkApi(app);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const nativeFetch = globalThis.fetch;
  let cookie = '', csrf = '';
  const requests: Array<{ path: string; method: string; status: number }> = [];
  const jsonRequest = async (route: string, method = 'GET', body?: unknown, authenticated = true) => {
    let result!: { status: number; json: any };
    await act(async () => {
      const response = await nativeFetch(base + '/api' + route, { method, headers: { 'content-type': 'application/json', ...(authenticated ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const json = await response.json() as any; if (json.csrfToken) csrf = json.csrfToken;
      const setCookie = response.headers.get('set-cookie'); if (setCookie && response.ok) cookie = setCookie.split(';')[0];
      result = { status: response.status, json };
    });
    return result;
  };
  assert.equal((await jsonRequest('/admin/bootstrap', 'POST', { setupToken: 'acceptance-setup', username: 'owner', password: '123456' }, false)).status, 200);
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: base + '/admin', virtualConsole: new VirtualConsole() });
  const globals = ['window','document','navigator','HTMLElement','IS_REACT_ACT_ENVIRONMENT'] as const, savedGlobals = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  globals.forEach(key => Object.defineProperty(globalThis, key, { configurable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key as keyof typeof dom.window] }));
  const catalogBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'PanelArk-Adapters', version: '99.0.0', entries: [{ id: '3x-ui', name: '签名目录验收', description: '', enabled: false, sortOrder: 1 }] }));
  const archiveBytes = Buffer.from('isolated-update-archive');
  const unsigned: Omit<ReleaseManifest,'signature'> = { schemaVersion: 1, product: 'PanelArk', version: '99.0.0', channel: 'stable', publishedAt: new Date().toISOString(), minVersion: '2.0.0', packageUrl: 'https://release.test/archive.tar.gz', sha256: createHash('sha256').update(archiveBytes).digest('hex'), notes: ['验收版本'], adapterCatalog: { version: '99.0.0', url: 'https://release.test/catalog.json', sha256: createHash('sha256').update(catalogBytes).digest('hex') } };
  const manifest = { ...unsigned, signature: sign(null, Buffer.from(canonicalManifest(unsigned)), pair.privateKey).toString('base64') };
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url), base);
    if (target.origin !== base) {
      if (target.pathname.endsWith('release-manifest.json')) return new Response(JSON.stringify(manifest));
      if (target.href === unsigned.packageUrl) return new Response(archiveBytes);
      if (target.href === unsigned.adapterCatalog.url) return new Response(catalogBytes);
      throw new Error('Unexpected external request: ' + target.href);
    }
    const headers = new Headers(options?.headers); headers.set('cookie', cookie);
    const response = await nativeFetch(target, { ...options, headers });
    requests.push({ path: target.pathname, method: options?.method || 'GET', status: response.status });
    if (response.headers.get('set-cookie') && response.ok) cookie = response.headers.get('set-cookie')!.split(';')[0];
    if (response.ok && ['/api/admin/session','/api/admin/login'].includes(target.pathname)) { const body=await response.clone().json() as any; if(body.csrfToken)csrf=body.csrfToken; }
    return response;
  };
  const downloads: Array<{ filename: string; content: Blob }> = [], blobs = new Map<string, Blob>();
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => { const url = `blob:acceptance-${blobs.size}`; blobs.set(url, blob as Blob); return url; }; URL.revokeObjectURL = () => {};
  const downloadedBackups: Promise<Buffer>[] = [];
  dom.window.HTMLAnchorElement.prototype.click = function () {
    const blob = blobs.get(this.href); if (blob) downloads.push({ filename: this.download, content: blob });
    else if (this.pathname.startsWith('/api/admin/backups/')) downloadedBackups.push(nativeFetch(this.href, { headers: { cookie } }).then(async res => { assert.equal(res.status,200); return Buffer.from(await res.arrayBuffer()); }));
  };
  const copied: string[] = []; Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied.push(value); } } });
  const { createRoot } = await import('react-dom/client'), { default: AdminApp } = await import('../src/admin/AdminApp.js');
  let root = createRoot(dom.window.document.getElementById('root')!);
  const doc = dom.window.document;
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
  const wait = async (check: () => boolean) => { for (let i=0;i<180 && !check();i++) await settle(); assert.ok(check(), doc.body.textContent?.slice(-1800)); };
  const modal = () => [...doc.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)!;
  const find = (text: string, scope: ParentNode = doc) => [...scope.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text);
  const click = async (text: string, scope: ParentNode = doc) => {
    let target = find(text,scope);
    if (!target && find('更多',scope)) { await act(async()=>find('更多',scope)!.click()); await settle(); target=find(text,doc.querySelector('[role="menu"]')!); }
    await wait(()=>Boolean(target || find(text,scope)) && !(target || find(text,scope))!.disabled);
    await act(async () => (target || find(text,scope))!.click()); await settle();
  };
  const dismiss = async () => { await wait(() => Boolean(modal() && find('知道了',modal()))); await click('知道了',modal()); };
  const fill = async (label: string, value: string, scope: ParentNode = modal() || doc) => {
    const node = [...scope.querySelectorAll('label')].find(l => l.querySelector('span')?.textContent === label)?.querySelector('input,select,textarea') as HTMLInputElement | HTMLSelectElement;
    assert.ok(node,label); await act(async () => {
      if (node.tagName === 'SELECT') { node.value=value; node.dispatchEvent(new dom.window.Event('change',{bubbles:true})); }
      else { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value); node.dispatchEvent(new dom.window.Event('input',{bubbles:true})); }
    });
  };
  const prompt = async (value: string) => { const node=modal().querySelector('input')!; assert.ok(node); await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(node,value); node.dispatchEvent(new dom.window.Event('input',{bubbles:true})); }); await click('确认',modal()); };
  const close = async () => { await act(async () => modal().querySelector<HTMLButtonElement>('[aria-label="关闭弹窗"]')!.click()); await settle(); };
  const row = (text: string, scope: ParentNode = doc) => { const node=[...scope.querySelectorAll('tbody tr')].find(n=>n.textContent?.includes(text)); assert.ok(node,`row ${text}`); return node; };
  const section = (heading: string) => { const node=[...doc.querySelectorAll('section')].find(s=>[...s.querySelectorAll('h2')].some(h=>h.textContent===heading)); assert.ok(node,heading);return node; };
  const remount = async (view: string) => { await act(async()=>root.unmount()); root=createRoot(doc.getElementById('root')!); await act(async()=>root.render(<AdminApp />)); await click(view); await settle(); };
  const disk = async (check: (persisted: PanelArkDatabase) => void) => { const persisted=await PanelArkDatabase.open(db.filePath); try { check(persisted); assert.deepEqual(persisted.all('PRAGMA foreign_key_check'),[]); } finally { persisted.close(); } };
  const loginOwner = async (password = '123456', username = 'owner') => { const result = await jsonRequest('/admin/login','POST',{username,password},false); assert.equal(result.status,200,JSON.stringify(result.json)); };
  let packageId='', firstCdk='', backupBytes: Buffer;
  try {
    await act(async()=>root.render(<AdminApp />)); await wait(()=>Boolean(find('任务售后')));
    await t.test('CDK / packages / batches: create, reveal, copy, export, edit, save, bulk statuses, delete and reload', async()=>{
      await click('CDK 管理');
      assert.equal(doc.querySelectorAll('[role="tabpanel"] .admin-table-panel').length,1,'default workspace shows only the CDK list');
      await click('新建套餐');
      const createForm=find('创建套餐')!.closest('form')!;
      await fill('套餐名称','全流程套餐',createForm); await fill('最多部署次数','5',createForm); await fill('有效天数','0',createForm); await fill('说明','验收套餐',createForm); await click('创建套餐',createForm); await dismiss();
      packageId=String(db.get("SELECT id FROM cdk_packages WHERE name='全流程套餐'")!.id);
      await click('批量生成');
      await fill('选择套餐',packageId,find('生成 CDK')!.closest('form')!); await fill('批次名称','全流程批次',find('生成 CDK')!.closest('form')!); await fill('生成数量','3',find('生成 CDK')!.closest('form')!); await click('生成 CDK');
      await wait(()=>Boolean(modal()?.querySelector('textarea'))); const codes=modal().querySelector('textarea')!.value.split('\n'); assert.equal(codes.length,3); firstCdk=codes[0]; await click('下载 TXT',modal()); assert.equal(await downloads.at(-1)!.content.text(),codes.join('\n')+'\n'); await click('完成',modal());
      const list=doc.querySelector('.cdk-management')!; await wait(()=>list.querySelectorAll('tbody tr').length===3);
      const one=list.querySelector('tbody tr')!; await click('查看',one); assert.ok(codes.includes(one.querySelector('code')!.textContent!)); await click('复制',one); await dismiss(); assert.ok(codes.includes(copied.at(-1)!));
      await click('编辑',one); await fill('总使用次数','9'); await fill('已使用次数','2'); await fill('有效期（留空永久有效）',''); await click('保存修改',modal()); await dismiss();
      await disk(p=>assert.ok(p.get("SELECT id FROM cdks WHERE max_uses_override=9 AND used_count=2 AND expires_at IS NULL")));
      await click('导出全部筛选结果'); await dismiss(); assert.equal((await downloads.at(-1)!.content.text()).trim().split('\n').length,3);
      await act(async()=>list.querySelector<HTMLInputElement>('[aria-label="选择当前页全部 CDK"]')!.click()); await click('批量停用'); await click('确认',modal()); await dismiss(); assert.equal(db.get("SELECT COUNT(*) total FROM cdks WHERE status='disabled'")!.total,3);
      await act(async()=>list.querySelector<HTMLInputElement>('[aria-label="选择当前页全部 CDK"]')!.click()); await click('批量启用'); await click('确认',modal()); await dismiss(); assert.equal(db.get("SELECT COUNT(*) total FROM cdks WHERE status='active'")!.total,3);
      await click('套餐管理'); await click('编辑套餐',row('全流程套餐',section('套餐管理'))); await fill('限定项目 ID（留空不限）','3x-ui'); await fill('限定分类（留空不限）','代理面板'); await click('保存',modal()); await dismiss();
      await remount('CDK 管理'); await click('套餐管理'); await wait(()=>Boolean(find('编辑套餐',section('套餐管理')))); await click('编辑套餐',row('全流程套餐',section('套餐管理'))); assert.equal([...modal().querySelectorAll('input')].find(n=>n.value==='3x-ui')?.value,'3x-ui'); await click('取消',modal());
      await click('批次管理');
      await click('重命名',row('全流程批次', [...doc.querySelectorAll('section')].find(s=>s.textContent?.includes('批次管理'))!)); await prompt('改名后的批次'); await dismiss(); assert.ok(db.get("SELECT id FROM cdk_batches WHERE name='改名后的批次'"));
      await click('CDK 列表');
      await click('删除',doc.querySelector('.cdk-management tbody tr')!); await click('取消',modal()); assert.equal(db.get('SELECT COUNT(*) total FROM cdks')!.total,3);
      await click('删除',doc.querySelector('.cdk-management tbody tr')!); await click('确认',modal()); await dismiss(); assert.equal(db.get('SELECT COUNT(*) total FROM cdks')!.total,2);
      await remount('CDK 管理'); await wait(()=>doc.querySelectorAll('.cdk-management tbody tr').length===2);
      const remainingList=doc.querySelector('.cdk-management')!;
      await act(async()=>remainingList.querySelector<HTMLInputElement>('[aria-label="选择当前页全部 CDK"]')!.click());
      const format=doc.querySelector<HTMLSelectElement>('[aria-label="导出格式"]')!; await act(async()=>{format.value='csv';format.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
      await click('导出选中'); await dismiss(); assert.match(await downloads.at(-1)!.content.text(),/改名后的批次/);
      await click('批量删除'); await click('取消',modal()); assert.equal(db.get('SELECT COUNT(*) total FROM cdks')!.total,2);
      await click('批量删除'); await click('确认',modal()); await dismiss(); await disk(p=>assert.equal(p.get('SELECT COUNT(*) total FROM cdks')!.total,0));
    });
    await t.test('task after-sales: actual executor cancellation, review and notes CRUD, refund idempotency, export, deletion', async()=>{
      const running=jobEngine.createJob({kind:'acceptance-cancel',serverKey:'isolated-host',steps:[{key:'wait',title:'等待安全取消'}]});
      const execution=jobEngine.startJob(running.id,async context=>{ await context.step('wait',()=>new Promise<void>((resolve,reject)=>{ context.signal.addEventListener('abort',()=>reject(context.signal.reason),{once:true}); })); });
      await click('任务售后'); await wait(()=>Boolean(find('详情与处理记录'))); await click('取消任务',row(running.id.slice(0,8))); await click('确认',modal()); await dismiss(); await execution; assert.equal(jobEngine.getJob(running.id)!.status,'cancelled');
      await click('刷新'); await click('详情与处理记录'); await wait(()=>Boolean(find('新增处理记录',modal()))); await click('新增处理记录',modal()); await prompt('第一次排查'); await dismiss(); await click('修改记录',modal()); await prompt('修复完成'); await dismiss();
      await click('编辑审核',modal()); await fill('审核备注','已解决'); await fill('处理状态','resolved'); await click('保存',modal()); await dismiss(); await disk(p=>assert.equal(p.get('SELECT status FROM job_reviews WHERE job_id=?',[running.id])!.status,'resolved'));
      await click('删除审核记录',modal()); await click('确认',modal()); await dismiss(); assert.equal(db.get('SELECT id FROM job_reviews WHERE job_id=?',[running.id]),undefined);
      await click('删除记录',modal()); await click('确认',modal()); await dismiss(); assert.equal(db.get('SELECT id FROM job_notes WHERE job_id=?',[running.id]),undefined); await close();
      await click('导出全部任务'); assert.match(await downloads.at(-1)!.content.text(),/acceptance-cancel/);
      const code=(await jsonRequest('/admin/batches','POST',{packageId,quantity:1})).json.codes[0];
      const valid=await jsonRequest('/cdk/validate','POST',{code},false); const taskKey='acceptance-refund'; await jsonRequest('/cdk/lock','POST',{grantToken:valid.json.grantToken,taskKey},false); await jsonRequest('/cdk/consume','POST',{grantToken:valid.json.grantToken,taskKey},false);
      const charged=jobEngine.createJob({kind:'acceptance-refund',serverKey:'isolated-refund',taskKey,steps:[{key:'fail',title:'验证失败'}]}); await jobEngine.startJob(charged.id,async()=>{throw new Error('验收预设失败');});
      await remount('任务售后'); await wait(()=>Boolean(find('详情与处理记录'))); await click('返还 CDK',row(charged.id.slice(0,8))); await prompt('安装失败返还'); await dismiss();
      const grant=db.get('SELECT * FROM cdk_grants WHERE task_key=?',[taskKey])!; assert.equal(grant.status,'released'); assert.equal(db.get('SELECT used_count FROM cdks WHERE id=?',[grant.cdk_id])!.used_count,0);
      await click('删除任务',row(charged.id.slice(0,8))); await click('确认',modal()); await dismiss(); assert.equal(jobEngine.getJob(charged.id),undefined); assert.ok(db.get('SELECT id FROM cdk_grants WHERE task_key=?',[taskKey]));
      await click('删除任务',row(running.id.slice(0,8))); await click('确认',modal()); await dismiss();
    });
    await t.test('catalog: full edit, clearing content, real public hide/show, reset and persisted reload', async()=>{
      await click('目录运营'); await wait(()=>Boolean(find('编辑项目'))); const project=row('3x-ui'); await click('编辑项目',project); await fill('项目名称','验收安装项目'); await fill('分类','代理面板'); await fill('介绍',''); await fill('排序（0—10000）','0'); await click('保存',modal()); await dismiss();
      await disk(p=>assert.equal(p.get("SELECT description FROM catalog_overrides WHERE adapter_id='3x-ui'")!.description,''));
      assert.equal((await jsonRequest('/admin/catalog')).json.items.find((item:any)=>item.id==='3x-ui').description,'','API readback must not replace intentionally empty descriptions');
      assert.equal((await jsonRequest('/adapters')).json.items.find((item:any)=>item.id==='3x-ui').description,'','public listing must agree with the saved description');
      await click('下架',row('3x-ui')); await dismiss(); assert.ok(!(await jsonRequest('/adapters')).json.items.some((x:any)=>x.id==='3x-ui'));
      await remount('目录运营'); await wait(()=>Boolean(find('编辑项目'))); await click('上架',row('3x-ui')); await dismiss(); assert.ok((await jsonRequest('/adapters')).json.items.some((x:any)=>x.id==='3x-ui'));
      await click('恢复默认',row('3x-ui')); await click('确认',modal()); await dismiss(); await disk(p=>assert.equal(p.get("SELECT adapter_id FROM catalog_overrides WHERE adapter_id='3x-ui'"),undefined));
    });
    await t.test('recommendations: every field saves, public listing changes, delete persists after reload', async()=>{
      await click('资源推荐'); await click('新增推荐'); await fill('标题','全字段推荐'); await fill('类型','domain'); await fill('说明','说明已保存'); await fill('标签','优选'); await fill('HTTPS 链接','https://example.test/resource'); await fill('排序（0—10000）','0'); await click('保存',modal()); await dismiss();
      const id=db.get("SELECT id FROM recommended_resources WHERE title='全字段推荐'")!.id;
      await remount('资源推荐'); await wait(()=>Boolean(find('编辑推荐'))); await click('编辑推荐'); await fill('标题','修改推荐'); await fill('说明',''); await fill('标签',''); await fill('排序（0—10000）','2'); await fill('状态','0'); await click('保存',modal()); await dismiss();
      await disk(p=>{const r=p.get('SELECT * FROM recommended_resources WHERE id=?',[id])!; assert.equal(r.title,'修改推荐'); assert.equal(r.description,''); assert.equal(r.badge,''); assert.equal(r.enabled,0); assert.equal(r.sort_order,2);});
      await click('删除',row('修改推荐')); await click('确认',modal()); await dismiss(); await remount('资源推荐'); await disk(p=>assert.equal(p.get('SELECT id FROM recommended_resources WHERE id=?',[id]),undefined));
    });
    await t.test('administrator accounts: create, rename, change role, disable/enable, reset password/2FA, revoke and delete', async()=>{
      await click('管理员'); await click('创建账号'); await fill('用户名','managed'); await fill('初始密码（至少 6 位）','123456'); await fill('角色','super_admin'); await click('保存',modal()); await dismiss();
      const id=db.get("SELECT id FROM admins WHERE username='managed'")!.id;
      await click('编辑账号',row('managed')); await fill('用户名','managed-next'); await fill('角色','operator'); await fill('状态','0'); await click('保存',modal()); await dismiss();
      assert.equal((await jsonRequest('/admin/login','POST',{username:'managed-next',password:'123456'},false)).status,401);
      await click('编辑账号',row('managed-next')); await fill('状态','1'); await click('保存',modal()); await dismiss();
      await click('重置密码',row('managed-next')); await prompt('654321'); await dismiss();
      const ownerCookie=cookie, ownerCsrf=csrf; assert.equal((await jsonRequest('/admin/login','POST',{username:'managed-next',password:'654321'},false)).status,200); const otherCookie=cookie;
      await jsonRequest('/admin/2fa/setup','POST',{currentPassword:'654321'}).then(async result=>{assert.equal(result.status,200); assert.equal((await jsonRequest('/admin/2fa/enable','POST',{code:totpCode(result.json.secret)})).status,200);});
      cookie=ownerCookie; csrf=ownerCsrf; await remount('管理员'); await wait(()=>Boolean(find('编辑账号'))); await click('重置 2FA',row('managed-next')); await click('确认',modal()); await dismiss(); assert.equal(db.get('SELECT totp_enabled FROM admins WHERE id=?',[id])!.totp_enabled,0);
      assert.equal((await nativeFetch(base+'/api/admin/session',{headers:{cookie:otherCookie}})).status,401);
      await click('撤销会话',row('managed-next')); await click('确认',modal()); await dismiss();
      await click('删除账号',row('managed-next')); await click('确认',modal()); await dismiss(); await remount('管理员'); await disk(p=>assert.equal(p.get('SELECT id FROM admins WHERE id=?',[id]),undefined));
    });
    await t.test('site settings: actual save/readback and public purchase redirect use the new link', async()=>{
      await click('站点配置'); await wait(()=>Boolean(find('保存配置')) && !find('保存配置')!.disabled);
      for(const [label,value] of [['站点名称','验收站点'],['站点地址（HTTP/HTTPS）','https://panel.example.test'],['购买按钮文字','购买验收码'],['购买 CDK 的跳转链接（HTTPS）','https://new.example.test/cdk'],['客服链接（HTTPS，不影响购买 CDK 跳转）','https://support.example.test'],['全站公告','验收公告']]) await fill(label,value,doc);
      await click('保存配置'); await dismiss(); await remount('站点配置'); await wait(()=>doc.querySelector<HTMLInputElement>('[data-saved-purchase]')?.textContent==='https://new.example.test/cdk');
      const redirect=await nativeFetch(base+'/api/public/purchase',{redirect:'manual'}); assert.equal(redirect.status,302); assert.equal(redirect.headers.get('location'),'https://new.example.test/cdk');
      await disk(p=>assert.equal(p.get("SELECT value FROM site_settings WHERE key='site_name'")!.value,'验收站点'));
      await fill('管理后台路径（仅超级管理员）','/acceptance-admin',doc); await click('保存配置');
      assert.equal((await jsonRequest('/admin/settings')).json.adminPath,'/acceptance-admin');
      dom.reconfigure({url:base+'/acceptance-admin'}); await remount('站点配置');
      await wait(()=>[...doc.querySelectorAll('input')].some(n=>n.value==='/acceptance-admin'));
      await fill('管理后台路径（仅超级管理员）','/admin',doc); await click('保存配置');
      dom.reconfigure({url:base+'/admin'}); await remount('站点配置');
    });
    await t.test('my account: actual password change, TOTP enable/disable and session revocation', async()=>{
      await click('我的账号'); await fill('当前密码','123456',doc); await fill('管理员用户名','owner-next',doc); await fill('新密码（不修改可留空）','654321',doc); await click('确认更新'); await dismiss();
      assert.equal((await jsonRequest('/admin/login','POST',{username:'owner',password:'123456'},false)).status,401); await loginOwner('654321','owner-next');
      await remount('我的账号'); await fill('当前密码','654321',doc); await click('设置 2FA'); await dismiss(); const secret=String(db.get("SELECT totp_secret FROM admins WHERE username='owner-next'")!.totp_secret);
      await fill('当前动态验证码',totpCode(secret),doc); await click('确认启用 2FA'); await dismiss(); assert.equal(db.get("SELECT totp_enabled FROM admins WHERE username='owner-next'")!.totp_enabled,1);
      const challenged=await jsonRequest('/admin/login','POST',{username:'owner-next',password:'654321'},false); assert.equal(challenged.status,401); assert.equal(challenged.json.code,'TOTP_REQUIRED');
      await click('停用 2FA'); await prompt(totpCode(secret)); await dismiss(); assert.equal(db.get("SELECT totp_enabled FROM admins WHERE username='owner-next'")!.totp_enabled,0);
      const current=cookie, currentCsrf=csrf; await loginOwner('654321','owner-next'); const extra=cookie; cookie=current; csrf=currentCsrf;
      await remount('我的账号'); await wait(()=>doc.querySelectorAll('tbody tr').length>=2); const other=[...doc.querySelectorAll('tbody tr')].find(n=>!n.textContent?.includes('当前'))!; await click('撤销',other); assert.equal((await nativeFetch(base+'/api/admin/session',{headers:{cookie:extra}})).status,401);
    });
    await t.test('backups: create, download real archive, preview, upload, label, schedule, restore and re-login', async()=>{
      await click('备份迁移'); await click('创建手动备份'); await prompt('123456'); await dismiss();
      const record=db.get("SELECT * FROM backup_records WHERE reason='manual' ORDER BY created_at DESC LIMIT 1")!;
      const link=row(String(record.filename)).querySelector<HTMLAnchorElement>('a')!; await act(async()=>link.click()); backupBytes=await downloadedBackups.at(-1)!; assert.equal(backupBytes.subarray(0,8).toString(),'PGBK0001');
      await click('预览',row(String(record.filename))); await prompt('wrong-password'); await dismiss(); assert.ok(db.get('SELECT id FROM backup_records WHERE id=?',[record.id]));
      await click('预览',row(String(record.filename))); await prompt('123456'); await wait(()=>modal()?.textContent?.includes('databaseBytes')===true); await dismiss();
      const upload=doc.querySelector<HTMLInputElement>('input[type="file"]')!; const file=new File([new Uint8Array(backupBytes)],'acceptance.pgbak',{type:'application/octet-stream'});
      await act(async()=>{Object.defineProperty(upload,'files',{value:[file],configurable:true}); upload.dispatchEvent(new dom.window.Event('change',{bubbles:true}));}); await dismiss(); const uploaded=db.get("SELECT * FROM backup_records WHERE reason='uploaded' ORDER BY created_at DESC LIMIT 1")!; assert.ok(fs.existsSync(path.join(directory,'backups',String(uploaded.filename))));
      await click('修改备注',row(String(uploaded.filename))); await prompt('上传验收备份'); await dismiss();
      await click('定时备份'); await fill('每日自动备份','1',modal()); await click('保存定时备份'); await dismiss(); await remount('备份迁移'); await click('定时备份'); await wait(()=>modal().querySelector('select')?.value==='1');
      await fill('每日自动备份','0',modal()); await click('保存定时备份'); await dismiss();
      await jsonRequest('/admin/settings','PUT',{...(await jsonRequest('/admin/settings')).json,siteNotice:'恢复前变更'});
      await click('恢复',row('上传验收备份')); await click('确认',modal()); await prompt('123456'); await dismiss();
      await wait(()=>Boolean(find('登录管理后台'))); assert.equal(db.get("SELECT value FROM site_settings WHERE key='site_notice'")!.value,'验收公告');
      assert.ok(db.get("SELECT id FROM backup_records WHERE reason='pre_restore'")); assert.ok(db.get('SELECT id FROM backup_records WHERE id=?',[uploaded.id]));
      await fill('管理员用户名','owner-next',doc); await fill('登录密码','654321',doc); await click('登录管理后台'); await wait(()=>Boolean(find('备份迁移'))); await click('备份迁移'); await wait(()=>Boolean(find('预览')));
      await click('删除备份',row('上传验收备份')); await click('确认',modal()); await dismiss(); await disk(p=>assert.equal(p.get('SELECT id FROM backup_records WHERE id=?',[uploaded.id]),undefined));
    });
    await t.test('audit: view real details, CSV contains all events, confirmed date cleanup persists', async()=>{
      db.run("INSERT INTO audit_logs(action,created_at,details) VALUES ('acceptance.old','2000-01-01T00:00:00.000Z','{}')");
      await click('审计日志'); await wait(()=>Boolean(find('查看详情'))); await click('查看详情'); await dismiss();
      await click('导出审计'); await wait(()=>downloads.at(-1)?.filename==='panelark-audit.csv'); const csv=await downloads.at(-1)!.content.text(); assert.match(csv,/acceptance.old/); assert.match(csv,/backup.restore/);
      await click('清理旧审计'); await prompt('2001-01-01'); await click('取消',modal()); assert.ok(db.get("SELECT id FROM audit_logs WHERE action='acceptance.old'"));
      await click('清理旧审计'); await prompt('2001-01-01'); await click('确认',modal()); await dismiss(); await remount('审计日志'); await disk(p=>{assert.equal(p.get("SELECT id FROM audit_logs WHERE action='acceptance.old'"),undefined);assert.ok(p.get("SELECT id FROM audit_logs WHERE action='audit.cleanup'"));});
    });
    await t.test('system update: real signed check/prepare/catalog save, unsupported application returns an explicit error', async()=>{
      await click('系统更新'); await wait(()=>Boolean(find('检测更新')) && !find('检测更新')!.disabled); await click('检测更新'); await dismiss(); assert.ok(fs.existsSync(path.join(directory,'update-state.json'))); assert.equal(db.get("SELECT COUNT(*) total FROM backup_records WHERE reason='managed_pre_update'")!.total,0,'checking alone must not back up or install');
      await click('独立更新适配器目录至 99.0.0'); await click('确认',modal()); await dismiss(); await disk(p=>assert.equal(p.get("SELECT value FROM site_settings WHERE key='adapter_catalog_version'")!.value,'99.0.0'));
      assert.equal((await jsonRequest('/admin/update/prepare','POST',{})).status,400,'panel mode must use its actual external process manager, not pretend to apply');
      process.env.PANELARK_DEPLOYMENT_MODE='standalone';
      await remount('系统更新'); await click('下载并安装更新'); await click('取消',modal());
      assert.ok(!requests.some(r=>r.path==='/api/admin/update/prepare' && r.status===200),'cancel must not download or apply');
      await click('下载并安装更新'); await click('确认',modal()); await wait(()=>modal()?.textContent?.includes('Linux')===true); await dismiss();
      const prepared=JSON.parse(fs.readFileSync(path.join(directory,'update-state.json'),'utf8')); assert.equal(prepared.phase,'prepared'); assert.ok(fs.existsSync(prepared.archivePath));
      assert.ok(requests.some(r=>r.path==='/api/admin/update/prepare' && r.status===200));
      assert.ok(requests.some(r=>r.path==='/api/admin/update/apply' && r.status===409),'non-production/non-Linux test must never launch a real updater');
      process.env.PANELARK_DEPLOYMENT_MODE='panel';
      const state=JSON.parse(fs.readFileSync(path.join(directory,'update-state.json'),'utf8')); state.phase='current'; fs.writeFileSync(path.join(directory,'update-state.json'),JSON.stringify(state));
    });
    await t.test('batch/package deletion and overview counters reflect actual data, not stale buttons', async()=>{
      await click('CDK 管理'); await click('批次管理'); await wait(()=>Boolean(find('删除批次'))); const batchRows=[...doc.querySelectorAll('section')].find(s=>s.textContent?.includes('批次管理'))!;
      const before=Number(db.get('SELECT COUNT(*) total FROM cdks')!.total); await click('删除批次',batchRows); await click('确认',modal()); await dismiss(); assert.ok(Number(db.get('SELECT COUNT(*) total FROM cdks')!.total)<before);
      await click('套餐管理'); await click('删除套餐',row('全流程套餐',section('套餐管理'))); await click('确认',modal()); await dismiss(); await click('批量生成');
      const packageSelect=[...find('生成 CDK')!.closest('form')!.querySelectorAll('select')][0];
      assert.notEqual(packageSelect.value,'','deleting the selected package must select a remaining enabled package');
      await click('生成 CDK'); await wait(()=>Boolean(modal()));
      assert.ok(modal().querySelector('textarea'),'remaining package must actually generate codes, not just appear selected'); await click('完成',modal());
      await remount('CDK 管理'); await disk(p=>assert.equal(p.get('SELECT id FROM cdk_packages WHERE id=?',[packageId]),undefined));
      await click('业务概览'); await wait(()=>doc.querySelectorAll('.admin-stat strong').length===6); const stats=(await jsonRequest('/admin/dashboard')).json.stats; assert.equal(Number(doc.querySelector('.admin-stat strong')!.textContent),stats.totalCdks);
      assert.ok(requests.some(r=>r.method==='POST' && r.path==='/api/admin/batches' && r.status===200));
      assert.ok(requests.some(r=>r.method==='PUT' && r.path.includes('/notes/') && r.status===200));
      assert.ok(requests.some(r=>r.method==='DELETE' && r.path.includes('/packages/') && r.status===200));
    });
  } finally {
    await act(async()=>root.unmount()); globalThis.fetch=nativeFetch; URL.createObjectURL=originalCreate; URL.revokeObjectURL=originalRevoke; dom.window.close();
    globals.forEach((key,i)=>{if(savedGlobals[i])Object.defineProperty(globalThis,key,savedGlobals[i]!);else delete(globalThis as any)[key];});
    await new Promise<void>(resolve=>server.close(()=>resolve())); db.close(); fs.rmSync(directory,{recursive:true,force:true}); keys.forEach((key,i)=>{if(savedEnv[i]===undefined)delete process.env[key];else process.env[key]=savedEnv[i];});
  }
});
