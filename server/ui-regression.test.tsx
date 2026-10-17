import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminAccess } from '../src/admin/AdminApp.js';
import { AdminApiError, adminApi, allPackageOptions } from '../src/admin/api.js';
import { PurchaseLink } from '../src/panelark/PurchaseLink.js';
import { CatalogPage, CdkGateModal, DeployModal, Header, HomePage } from '../src/panelark/ui.js';
import { ThemeToggle, resolveInitialTheme } from '../src/panelark/theme.js';
import { getPublicConfig } from '../src/panelark/api.js';
import { PanelArkMark } from '../src/components/PanelArkMark.js';
import { adapterMetadataToCatalog, deploymentPorts, panels, tools } from '../src/panelark/catalog.js';
import type { PanelAdapterMetadata } from '../src/panelark/api.js';
import type { ActiveServer } from '../src/panelark/types.js';
import { JSDOM } from 'jsdom';

const noop = () => {};
test('AI project ports are configurable and CPA callback ports cannot collide with its API port', () => {
  for (const id of ['new-api', 'one-api']) {
    const item = panels.find(item => item.id === id)!;
    assert.deepEqual(deploymentPorts(item, '4317', false, ''), [4317]);
    assert.throws(() => deploymentPorts(item, '65536', false, ''), /服务端口/);
  }
  const cpa = panels.find(item => item.id === 'cliproxyapi')!;
  assert.deepEqual(deploymentPorts(cpa, '9317', false, ''), [9317, 8085, 1455, 54545, 51121, 11451]);
  assert.throws(() => deploymentPorts(cpa, '8085', false, ''), /OAuth 回调端口/);
  assert.deepEqual(deploymentPorts(panels.find(item => item.id === 'bt-panel')!, '28641', false, ''), []);
});

test('public catalog and deployment confirmation show requirements but never internal acceptance labels', () => {
  // Simulate stale metadata from a previous server: the UI must not render it.
  const items = panels.map(item => ({ ...item, supportLevel: 'pending', verifiedSystems: ['internal-test-system'] }));
  const html = renderToStaticMarkup(<CatalogPage items={items} title="面板目录" eyebrow="Catalog" description="test" deploymentUnlocked={false} serverConnected={false} purchaseEnabled={false} purchaseButtonText="购买 CDK" onDeploy={noop} onConnect={noop} />);
  const confirmation = renderToStaticMarkup(<DeployModal item={items.find(item => item.id === 'new-api')!} grantToken="test-grant" server={{ sessionId: 'test-session', environment: { targetHost: 'example.test', sshPort: 22 } } as ActiveServer} onConsumed={noop} onClose={noop} onToast={noop} />);
  for (const surface of [html, confirmation]) {
    assert.doesNotMatch(surface, /验收|实机已测|实机已验证|实测环境|internal-test-system/);
    assert.match(surface, /Ubuntu 20.04\+/);
    assert.match(surface, /Debian 11\+/);
    assert.match(surface, /amd64/);
    assert.match(surface, /systemd/);
  }
  assert.match(html, /无需手工准备/);
  assert.match(html, /Docker Engine \+ Docker Compose/);
  assert.match(html, /可用磁盘/);
});

test('public catalog mapping drops stale internal metadata and never fabricates installation state', () => {
  const metadata = { ...panels.find(item => item.id === 'new-api')!, enabled: true, supportLevel: 'pending', verifiedSystems: ['internal-test-system'] };
  const [mapped] = adapterMetadataToCatalog([metadata as unknown as PanelAdapterMetadata]);
  assert.equal('supportLevel' in mapped, false);
  assert.equal('verifiedSystems' in mapped, false);
  assert.ok([...panels, ...tools].every(item => item.installed === undefined));
  for (const serverConnected of [false, true]) {
    const html = renderToStaticMarkup(<CatalogPage items={[mapped]} title="面板目录" eyebrow="Catalog" description="test" deploymentUnlocked={serverConnected} serverConnected={serverConnected} purchaseEnabled={false} purchaseButtonText="购买 CDK" onDeploy={noop} onConnect={noop} />);
    assert.doesNotMatch(html, />已安装<|>未安装</);
  }
});
test('all brand surfaces use the shared PanelArk symbol and favicon', () => {
  const symbol = renderToStaticMarkup(<PanelArkMark size={24} aria-label="PanelArk" />);
  assert.match(symbol, /data-panelark-mark=""/);
  assert.match(symbol, /viewBox="0 0 24 24"/);
  assert.match(symbol, /fill-rule="evenodd"/);

  const header = renderToStaticMarkup(<Header theme="light" view="home" mobileMenuOpen={false} deploymentUnlocked={false} serverConnected={false} onToggleTheme={noop} onToggleMenu={noop} onViewChange={noop} onConnect={noop} purchaseEnabled={false} purchaseButtonText="购买 CDK" />);
  const admin = renderToStaticMarkup(<AdminAccess mode="login" theme="dark" onToggleTheme={noop} notice={null} setNotice={noop} onAuthenticated={noop} />);
  for (const surface of [header, admin]) {
    assert.match(surface, /data-panelark-mark=""/);
    assert.doesNotMatch(surface, /lucide-layers-3/);
  }

  const favicon = fs.readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
  const document = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(favicon, /fill="#e0b83a"/);
  assert.match(document, /rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/);
});
test('CDK step frame keeps symmetric inner padding without changing the original font size', () => {
  const html = renderToStaticMarkup(<CdkGateModal purchaseEnabled purchaseButtonText="购买 CDK" onClose={noop} onVerified={noop} />);
  const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const flowCss = css.slice(css.indexOf('.deployment-flow{'), css.indexOf('.catalog-grid{'));
  const dom = new JSDOM(`<style>${flowCss}</style>${html}`);
  try {
    const flow = dom.window.document.querySelector<HTMLElement>('.license-body .deployment-flow.compact')!;
    const style = dom.window.getComputedStyle(flow);
    assert.equal(style.paddingTop, '14px'); assert.equal(style.paddingBottom, '14px');
    assert.equal(style.paddingLeft, '16px'); assert.equal(style.paddingRight, '16px');
    assert.equal(style.borderRadius, '15px');
    const first = flow.firstElementChild!;
    assert.equal(dom.window.getComputedStyle(first).alignItems, 'center');
    assert.equal(dom.window.getComputedStyle(first).fontSize, '10px');
    assert.equal(first.getAttribute('aria-current'), 'step');
    assert.notEqual(dom.window.getComputedStyle(first.querySelector('i')!).position, 'absolute');
    assert.doesNotMatch(flowCss, /padding:0 0 16px/);
  } finally { dom.window.close(); }
});
test('batch package choices include every page, not only the first 100 packages', async () => {
  const original = globalThis.fetch;
  const pages: number[] = [];
  try {
    globalThis.fetch = async url => {
      const query = new URL(String(url), 'http://localhost').searchParams;
      const page = Number(query.get('page')); pages.push(page);
      assert.equal(query.get('pageSize'), '100');
      const start = (page - 1) * 100;
      const items = Array.from({ length: Math.min(100, 203 - start) }, (_, index) => ({ id: `package-${start + index}` }));
      return new Response(JSON.stringify({ success: true, items, pagination: { page, pageSize: 100, total: 203, totalPages: 3 } }));
    };
    const options = await allPackageOptions();
    assert.equal(options.length, 203); assert.equal(options.at(-1)?.id, 'package-202'); assert.deepEqual(pages, [1,2,3]);
  } finally { globalThis.fetch = original; }
});
test('login does not display or require a 2FA input before the server requests it', () => {
  const html = renderToStaticMarkup(<AdminAccess mode="login" theme="dark" onToggleTheme={noop} notice={null} setNotice={noop} onAuthenticated={noop} />);
  assert.doesNotMatch(html, /one-time-code|pattern="\[0-9\]/);
  assert.match(html, /未启用双重验证的账号/); assert.match(html, /切换为浅色主题/);
});

test('purchase links use a normal browser anchor to a fresh server redirect, and honor disable', () => {
  const html = renderToStaticMarkup(<PurchaseLink enabled text="购买授权" />);
  assert.match(html, /href="\/api\/public\/purchase"/); assert.match(html, /target="_blank"/); assert.match(html, /noopener noreferrer/);
  assert.match(html, /购买授权/); assert.equal(renderToStaticMarkup(<PurchaseLink enabled={false} />), '');
});

test('header, homepage, catalog and CDK modal all provide a purchase entry', () => {
  const common = { deploymentUnlocked: false, serverConnected: false, purchaseEnabled: true, purchaseButtonText: '购买 CDK' };
  const views = [
    <Header {...common} theme="light" view="home" mobileMenuOpen={false} onToggleTheme={noop} onToggleMenu={noop} onViewChange={noop} onConnect={noop} />,
    <HomePage {...common} recommendedResources={[]} onOpenResource={noop} onStart={noop} onOpenDocs={noop} onViewPanels={noop} onConnect={noop} onToast={noop} />,
    <CatalogPage {...common} items={[]} title="面板目录" eyebrow="Catalog" description="test" onDeploy={noop} onConnect={noop} />,
    <CdkGateModal purchaseEnabled purchaseButtonText="购买 CDK" onClose={noop} onVerified={noop} />,
  ];
  for (const view of views) assert.match(renderToStaticMarkup(view), /href="\/api\/public\/purchase"/);
  assert.doesNotMatch(renderToStaticMarkup(<CatalogPage {...common} purchaseEnabled={false} items={[]} title="目录" eyebrow="Catalog" description="test" onDeploy={noop} onConnect={noop} />), /href="\/api\/public\/purchase"/);
});

test('theme controls offer both directions and default safely outside the browser', () => {
  assert.equal(resolveInitialTheme(), 'light');
  assert.match(renderToStaticMarkup(<ThemeToggle theme="light" onToggle={noop} />), /切换为暗色主题/);
  assert.match(renderToStaticMarkup(<ThemeToggle theme="dark" onToggle={noop} />), /切换为浅色主题/);
});

test('admin error codes preserve the server 2FA challenge; public configuration bypasses cache', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ code: 'TOTP_REQUIRED', error: '输入动态码' }), { status: 401 });
    await assert.rejects(adminApi.login('owner', '123456'), error => error instanceof AdminApiError && error.code === 'TOTP_REQUIRED');
    globalThis.fetch = async (_url, options) => { assert.equal(options?.cache, 'no-store'); return new Response(JSON.stringify({ purchaseUrl: 'https://shop.example/' })); };
    assert.equal((await getPublicConfig()).purchaseUrl, 'https://shop.example/');
  } finally { globalThis.fetch = original; }
});

test('admin and centered dialogs inherit the original warm ivory / warm black and gold design', () => {
  const css = fs.readFileSync(new URL('../src/admin/admin.css', import.meta.url), 'utf8');
  const original = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /--(?:bg-primary|accent|text-primary):/);
  assert.match(original, /--bg-primary:#1a1916/); assert.match(original, /--accent:#e0b83a/);
  assert.match(css, /admin-dialog-backdrop\{position:fixed;inset:0;[^}]*place-items:center/);
  assert.match(css, /background:var\(--bg-secondary\);color:var\(--text-primary\)/);
  const lum = (hex: string) => hex.slice(1).match(/../g)!.map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  for (const block of original.split('}').slice(0,2)) {
    const value = (name: string) => block.match(new RegExp(`--${name}:(#[0-9a-f]{6});`))![1];
    const background = lum(value('bg-secondary'));
    for (const role of ['text-primary','text-secondary']) {
      const color = lum(value(role));
      assert.ok((Math.max(color,background)+.05)/(Math.min(color,background)+.05) >= 4.5);
    }
  }
  const admin = fs.readFileSync(new URL('../src/admin/AdminApp.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(admin, /window\.(alert|confirm|prompt)\(/);
  const cdkManager = fs.readFileSync(new URL('../src/admin/CdkManagement.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(cdkManager, /window\.(alert|confirm|prompt)\(/);
  assert.equal((`${admin}\n${cdkManager}`.match(/\{pager\}/g) || []).length, 8);
});
