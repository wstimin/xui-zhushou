import assert from 'node:assert/strict';
import test from 'node:test';
import { createUpdateRefreshCheck, updateReloadParameter } from '../src/admin/update-refresh.js';
import type { UpdateState } from '../src/admin/api.js';

function fixture() {
  const urls: string[] = [], warnings: string[] = [];
  let statusCalls = 0;
  const value = {
    health: { status: 'ok', version: '2.4.1' },
    state: { phase: 'completed', currentVersion: '2.4.1', targetVersion: '2.4.1' } as UpdateState,
    location: 'https://panel.example/custom/console?filter=all#updates',
    healthError: false,
  };
  const dependencies = {
    loadedVersion: '2.4.0',
    health: async (_signal: AbortSignal) => { if (value.healthError) throw new Error('restarting'); return value.health; },
    status: async (_signal: AbortSignal) => { statusCalls++; return { state: value.state }; },
    url: () => value.location,
    replace: (url: string) => { urls.push(url); value.location = url; },
    warn: (text: string) => warnings.push(text),
  };
  return { value, dependencies, urls, warnings, statusCalls: () => statusCalls };
}
const signal = () => new AbortController().signal;

test('successful healthy update reloads once, retains the custom admin path and bypasses HTML caches', async () => {
  const f = fixture(), monitor = createUpdateRefreshCheck(f.dependencies);
  await monitor.check(signal()); await monitor.check(signal());
  assert.equal(f.urls.length, 1);
  const url = new URL(f.urls[0]);
  assert.equal(url.pathname, '/custom/console'); assert.equal(url.searchParams.get('filter'), 'all');
  assert.equal(url.hash, '#updates'); assert.equal(url.searchParams.get(updateReloadParameter), '2.4.1');
  assert.equal(f.statusCalls(), 1);
});

test('current bundle and metadata-only checks never reload or install anything', async () => {
  const f = fixture(); f.value.health.version = '2.4.0';
  await createUpdateRefreshCheck(f.dependencies).check(signal());
  assert.equal(f.statusCalls(), 0); assert.equal(f.urls.length, 0);
  for (const phase of ['idle', 'checking', 'available', 'current', 'downloading', 'prepared', 'applying', 'restarting', 'failed', 'rolled_back'] as UpdateState['phase'][]) {
    f.value.health.version = '2.4.1'; f.value.state.phase = phase;
    await createUpdateRefreshCheck(f.dependencies).check(signal());
  }
  assert.equal(f.urls.length, 0);
});

test('server restart or an unhealthy/malformed health reply waits for recovery', async () => {
  const f = fixture(), monitor = createUpdateRefreshCheck(f.dependencies);
  f.value.healthError = true; await monitor.check(signal());
  f.value.healthError = false; f.value.health.status = 'starting'; await monitor.check(signal());
  f.value.health.status = 'ok'; f.value.health.version = ''; await monitor.check(signal());
  assert.equal(f.urls.length, 0); assert.equal(f.statusCalls(), 0);
  f.value.health.version = '2.4.1'; await monitor.check(signal()); assert.equal(f.urls.length, 1);
});

test('completed state must match the actually healthy target and contain no failure', async () => {
  const f = fixture(), monitor = createUpdateRefreshCheck(f.dependencies);
  f.value.state.currentVersion = '2.4.0'; await monitor.check(signal());
  f.value.state.currentVersion = '2.4.1'; f.value.state.targetVersion = '2.4.2'; await monitor.check(signal());
  f.value.state.targetVersion = '2.4.1'; f.value.state.error = 'health failed'; await monitor.check(signal());
  assert.equal(f.urls.length, 0);
  f.value.state.error = undefined; await monitor.check(signal()); assert.equal(f.urls.length, 1);
});

test('a proxy still serving the old bundle cannot cause an infinite reload loop', async () => {
  const f = fixture();
  const url = new URL(f.value.location); url.searchParams.set(updateReloadParameter, '2.4.1'); f.value.location = url.toString();
  const monitor = createUpdateRefreshCheck(f.dependencies);
  await monitor.check(signal()); await monitor.check(signal());
  assert.equal(f.urls.length, 0); assert.match(f.warnings[0], /旧页面资源/);
});

test('overlapping timers, aborted probes and an unmounted page cannot navigate', async () => {
  const f = fixture();
  let resolve!: (value: { status: string; version: string }) => void, healthCalls = 0;
  const pending = new Promise<{ status: string; version: string }>(done => { resolve = done; });
  f.dependencies.health = async () => { healthCalls++; return pending; };
  const monitor = createUpdateRefreshCheck(f.dependencies), controller = new AbortController();
  const first = monitor.check(controller.signal); await monitor.check(signal());
  assert.equal(healthCalls, 1); controller.abort(); resolve({ status: 'ok', version: '2.4.1' }); await first;
  assert.equal(f.urls.length, 0); assert.equal(f.statusCalls(), 0);
  monitor.stop(); await monitor.check(signal()); assert.equal(healthCalls, 1);
});
