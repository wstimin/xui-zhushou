import { useEffect, useState } from 'react';
import { adminApi, type UpdateState } from './api';

declare const __PANELARK_BUILD_VERSION__: string;
const versionPattern = /^\d+\.\d+\.\d+$/;
export const updateReloadParameter = '_panelark_reload';
export function loadedBuildVersion() { return typeof __PANELARK_BUILD_VERSION__ === 'string' ? __PANELARK_BUILD_VERSION__ : ''; }

interface RefreshDependencies {
  loadedVersion: string;
  health: (signal: AbortSignal) => Promise<{ status?: string; version?: string }>;
  status: (signal: AbortSignal) => Promise<{ state: UpdateState }>;
  url: () => string;
  replace: (url: string) => void;
  warn: (message: string) => void;
}

export function createUpdateRefreshCheck(dependencies: RefreshDependencies) {
  let busy = false, stopped = false, navigating = false;
  return {
    stop() { stopped = true; },
    async check(signal: AbortSignal) {
      if (busy || stopped || navigating || !versionPattern.test(dependencies.loadedVersion)) return;
      busy = true;
      try {
        const health = await dependencies.health(signal);
        if (signal.aborted || stopped || health.status !== 'ok' || !versionPattern.test(health.version || '') || health.version === dependencies.loadedVersion) return;
        const { state } = await dependencies.status(signal);
        // Checking metadata, downloading, restart failures and rollbacks must never cause navigation.
        if (signal.aborted || stopped || state.phase !== 'completed' || state.error || state.currentVersion !== health.version || state.targetVersion && state.targetVersion !== health.version) return;
        const url = new URL(dependencies.url());
        if (url.searchParams.get(updateReloadParameter) === health.version) {
          dependencies.warn('新版本服务已正常运行，但浏览器或代理仍返回旧页面资源。请强制刷新，并检查代理缓存规则。');
          return;
        }
        // A unique URL bypasses old HTML caches and guards against a stale proxy causing a reload loop.
        url.searchParams.set(updateReloadParameter, health.version!);
        navigating = true;
        dependencies.replace(url.toString());
      } catch {
        // Expected while PM2 is restarting: wait for the next probe, without re-running an update.
      } finally { busy = false; }
    },
  };
}

export function useUpdatePageReload(state: UpdateState | null) {
  const [warning, setWarning] = useState('');
  const phase = state?.phase;
  useEffect(() => {
    const loadedVersion = loadedBuildVersion();
    if (!versionPattern.test(loadedVersion)) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get(updateReloadParameter) === loadedVersion) {
      url.searchParams.delete(updateReloadParameter);
      window.history.replaceState(window.history.state, '', url);
    }
    const check = createUpdateRefreshCheck({
      loadedVersion,
      health: async signal => {
        const response = await fetch(`/api/health?_panelark_probe=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin', signal });
        if (!response.ok) throw new Error('服务尚未恢复');
        return response.json();
      },
      status: signal => adminApi.updateStatus(signal),
      url: () => window.location.href,
      replace: target => window.location.replace(target),
      warn: setWarning,
    });
    let controller: AbortController | undefined;
    const probe = () => {
      // Never overlap health probes, even when focus and a timer arrive together.
      if (controller) return;
      const next = new AbortController(); controller = next;
      const timeout = window.setTimeout(() => next.abort(), 8000);
      void check.check(next.signal).finally(() => { window.clearTimeout(timeout); if (controller === next) controller = undefined; });
    };
    probe();
    const timer = window.setInterval(probe, ['applying', 'restarting', 'completed'].includes(phase || '') ? 4000 : 15000);
    const visible = () => { if (document.visibilityState !== 'hidden') probe(); };
    window.addEventListener('focus', probe); document.addEventListener('visibilitychange', visible);
    return () => { check.stop(); controller?.abort(); window.clearInterval(timer); window.removeEventListener('focus', probe); document.removeEventListener('visibilitychange', visible); };
  }, [phase]);
  return warning;
}
