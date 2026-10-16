import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminAccess } from '../src/admin/AdminApp.js';
import { AdminApiError, adminApi, allPackageOptions } from '../src/admin/api.js';
import { PurchaseLink } from '../src/panelark/PurchaseLink.js';
import { CatalogPage, CdkGateModal, Header, HomePage } from '../src/panelark/ui.js';
import { ThemeToggle, resolveInitialTheme } from '../src/panelark/theme.js';
import { getPublicConfig } from '../src/panelark/api.js';
import { JSDOM } from 'jsdom';

const noop = () => {};
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
  assert.equal((admin.match(/\{pager\}/g) || []).length, 8);
});
