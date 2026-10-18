import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const shellQuote = value => `'${value.replace(/'/g, `'"'"'`)}'`;

export function shortcutContent(targetDirectory) {
  const script = shellQuote(path.join(targetDirectory, 'install.sh'));
  return `#!/usr/bin/env bash
# PanelArk managed shortcut
if [ -f ${script} ]; then
  exec bash ${script} "$@"
else
  echo "[ERROR] PanelArk 管理脚本缺失，请检查安装目录。"
  exit 1
fi
`;
}

// Exact previous-release format, not a loose substring match against foreign scripts.
function legacyContent(targetDirectory) {
  return `#!/usr/bin/env bash
# PanelArk managed shortcut
if [ -f "${targetDirectory}/install.sh" ]; then
  exec bash "${targetDirectory}/install.sh" "$@"
else
  echo "[ERROR] 部署助手脚本文件未找到，请重新运行一键安装命令！"
  exit 1
fi
`;
}

export function repairCommandShortcuts({ targetDirectory, shortcutDirectory = '/usr/local/bin' }) {
  if (!path.isAbsolute(targetDirectory) || !path.isAbsolute(shortcutDirectory)
    || /[\r\n\0]/.test(targetDirectory + shortcutDirectory)
    || path.resolve(targetDirectory) === path.parse(targetDirectory).root) throw new Error('拒绝不安全的快捷命令目录');
  const target = path.resolve(targetDirectory), destination = path.resolve(shortcutDirectory);
  if (!fs.statSync(path.join(target, 'install.sh')).isFile()) throw new Error('PanelArk 管理脚本不存在');
  if (fs.existsSync(destination) && !fs.lstatSync(destination).isDirectory()) throw new Error('快捷命令目录不是普通目录');
  fs.mkdirSync(destination, { recursive: true });
  const content = shortcutContent(target);
  const result = { repaired: [], unchanged: [], conflicts: [], errors: [] };
  for (const name of ['pa', 'sy']) {
    const file = path.join(destination, name);
    let temporary;
    try {
      let existing;
      try { existing = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) {
        if (!existing.isFile()) { result.conflicts.push(name); continue; }
        const oldContent = fs.readFileSync(file, 'utf8');
        if (oldContent !== content && oldContent !== legacyContent(target)) { result.conflicts.push(name); continue; }
        if (oldContent === content && (existing.mode & 0o777) === 0o755) { result.unchanged.push(name); continue; }
      }
      temporary = path.join(destination, `.panelark-${name}-${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o755 });
      fs.chmodSync(temporary, 0o755);
      if (existing) fs.renameSync(temporary, file);
      else {
        // Exclusive publication: never replace a foreign command created after our check.
        fs.linkSync(temporary, file);
        fs.unlinkSync(temporary);
      }
      result.repaired.push(name);
    } catch (error) { result.errors.push(`${name}: ${error.message}`); }
    finally { if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  return result;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = repairCommandShortcuts({ targetDirectory: process.argv[2], shortcutDirectory: process.argv[3] || '/usr/local/bin' });
    console.log(JSON.stringify(result));
    if (result.conflicts.length || result.errors.length) process.exitCode = 1;
  } catch (error) { console.error(`[ERROR] ${error.message}`); process.exitCode = 1; }
}
