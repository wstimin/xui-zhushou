import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function ensureStandaloneShortcuts(options: {
  targetDirectory?: string; shortcutDirectory?: string; platform?: NodeJS.Platform;
  uid?: number; mode?: string; production?: boolean; warn?: (text: string) => void;
} = {}) {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? process.getuid?.();
  const mode = options.mode ?? process.env.PANELARK_DEPLOYMENT_MODE;
  const production = options.production ?? process.env.NODE_ENV === 'production';
  if (platform !== 'linux' || uid !== 0 || mode !== 'standalone' || !production) return { skipped: true };
  const target = path.resolve(options.targetDirectory ?? process.cwd());
  const helper = path.join(target, 'scripts', 'command-shortcuts.mjs');
  const warn = options.warn ?? console.warn;
  if (!fs.existsSync(helper)) { warn('[WARN] 快捷命令修复工具缺失；网站继续启动。'); return { skipped: false, ok: false }; }
  const result = spawnSync(process.execPath, [helper, target, options.shortcutDirectory ?? '/usr/local/bin'], { encoding: 'utf8', timeout: 10000 });
  if (result.error || result.status !== 0) warn(`[WARN] pa / sy 部分快捷命令未修复（不会覆盖其他程序）；网站继续启动。${result.error?.message || result.stderr || result.stdout}`);
  return { skipped: false, ok: !result.error && result.status === 0 };
}
