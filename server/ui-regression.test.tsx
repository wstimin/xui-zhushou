import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminAccess } from '../src/admin/AdminApp.js';
import { AdminApiError, adminApi } from '../src/admin/api.js';
import { PurchaseLink } from '../src/panelark/PurchaseLink.js';
import { CatalogPage, CdkGateModal, Header, HomePage } from '../src/panelark/ui.js';
import { ThemeToggle, resolveInitialTheme } from '../src/panelark/theme.js';
import { getPublicConfig } from '../src/panelark/api.js';

const noop = () => {};
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

test('admin light and dark secondary text have readable contrast against their card surfaces', () => {
  const css = fs.readFileSync(new URL('../src/admin/admin.css', import.meta.url), 'utf8');
  const lum = (hex: string) => hex.slice(1).match(/../g)!.map(v => parseInt(v,16)/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  for (const block of css.split('}').slice(0,2)) {
    const value = (name: string) => block.match(new RegExp(`--${name}:(#[0-9a-f]{6});`))![1];
    const background = lum(value('bg-elevated'));
    for (const role of ['text-primary','text-secondary','text-tertiary']) {
      const color = lum(value(role)), contrast = (Math.max(color,background)+.05)/(Math.min(color,background)+.05);
      assert.ok(contrast >= 4.5, `${role}: ${contrast}`);
    }
  }
});
