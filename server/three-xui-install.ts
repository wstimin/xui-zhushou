import { normalizeWebPath, validPort } from './validation.js';
import { shellQuote } from './ssh.js';

export const OFFICIAL_THREE_XUI_INSTALLER = 'https://raw.githubusercontent.com/MHSanaei/3x-ui/master/install.sh';

export function officialThreeXUiPolicy(body: Record<string, unknown>) {
  if (body.scriptType === 'custom') throw new Error('3x-ui 仅使用 MHSanaei 官方安装脚本，不支持魔改或自定义安装源');
  // Older clients sent "recommended". It now means official, never the old fork.
  const sslMode: 'none' | 'domain' | 'ip' = body.autoSSL || body.scriptType === 'recommended' ? body.domain ? 'domain' : 'ip' : 'none';
  return { scriptType: 'official' as const, scriptUrl: OFFICIAL_THREE_XUI_INSTALLER, sslMode };
}

export function officialThreeXUiReadCommand(useSudo: boolean, files: { resultFile?: string; cli?: string } = {}) {
  const resultFile = shellQuote(files.resultFile || '/etc/x-ui/install-result.env');
  const script = [
    'set -e; set -o pipefail',
    'systemctl is-active --quiet x-ui || exit 40',
    `xui=${shellQuote(files.cli || '/usr/local/x-ui/x-ui')}`,
    'test -x "$xui" || exit 42',
    `test -s ${resultFile} || { echo "官方安装结果文件缺失，请使用 x-ui 查看或重置登录信息，不要重复安装" >&2; exit 41; }`,
    'unset XUI_USERNAME XUI_PASSWORD XUI_PANEL_PORT XUI_WEB_BASE_PATH XUI_ACCESS_URL XUI_API_TOKEN',
    `. ${resultFile}`,
    'test -n "${XUI_USERNAME:-}" && test -n "${XUI_PASSWORD:-}" || exit 43',
    'settings=$("$xui" setting -show) || exit 44',
    'certs=$("$xui" setting -getCert) || exit 45',
    'token="${XUI_API_TOKEN:-}"',
    'if [ -z "$token" ]; then token_output=$("$xui" setting -getApiToken) || exit 46; token=$(printf "%s\\n" "$token_output" | sed -n "s/^[[:space:]]*apiToken:[[:space:]]*//p" | head -n 1); fi',
    'emit() { printf "__XUI_OFFICIAL_%s__=%s\\n" "$1" "$(printf "%s" "$2" | base64 | tr -d "\\r\\n")"; }',
    'emit USERNAME "$XUI_USERNAME"; emit PASSWORD "$XUI_PASSWORD"',
    'emit PANEL_PORT "${XUI_PANEL_PORT:-}"; emit WEB_BASE_PATH "${XUI_WEB_BASE_PATH:-}"',
    'emit ACCESS_URL "${XUI_ACCESS_URL:-}"; emit API_TOKEN "$token"',
    'emit SETTINGS "$settings"; emit CERTS "$certs"',
  ].join('\n');
  return `${useSudo ? 'sudo -n ' : ''}bash -c ${shellQuote(script)}`;
}

const recovery = '面板可能已经安装，请在服务器执行 x-ui 查看或重置登录信息；不要重复安装。';
export function officialThreeXUiReadError(code: number) {
  const reasons: Record<number, string> = { 40: 'x-ui 服务未运行', 41: '官方 /etc/x-ui/install-result.env 文件缺失', 42: '官方 x-ui 可执行文件缺失', 43: '官方结果文件缺少账号或密码', 44: '官方当前配置查询失败', 45: '官方证书状态查询失败', 46: '官方 API Token 查询失败' };
  return `${reasons[code] || `读取官方安装结果失败（退出码 ${code}）`}。${recovery}`;
}
export function parseOfficialThreeXUiResult(output: string) {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^__XUI_OFFICIAL_([A-Z_]+)__=([A-Za-z0-9+/]*={0,2})$/);
    if (!match) continue;
    if (Object.hasOwn(values, match[1])) throw new Error(`官方安装结果字段重复。${recovery}`);
    values[match[1]] = Buffer.from(match[2], 'base64').toString('utf8');
  }
  if (!values.USERNAME || !values.PASSWORD || !values.API_TOKEN || !values.ACCESS_URL) throw new Error(`未能读取完整的官方安装结果（账号、密码、访问地址或 API Token 缺失）。${recovery}`);
  if (/[\x00-\x1F\x7F]/.test(values.USERNAME + values.PASSWORD + values.API_TOKEN)) throw new Error(`官方登录信息包含无效控制字符。${recovery}`);
  const plain = (value: string) => (value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const portMatch = plain(values.SETTINGS).match(/^port:\s*(\d+)\s*$/im);
  const pathMatch = plain(values.SETTINGS).match(/^webBasePath:[ \t]*(.*)$/im);
  const certMatch = plain(values.CERTS).match(/^cert:[ \t]*(.*)$/im);
  const keyMatch = plain(values.CERTS).match(/^key:[ \t]*(.*)$/im);
  if (!portMatch || !pathMatch || !certMatch || !keyMatch) throw new Error(`官方配置查询不完整，无法确认端口、路径或证书状态。${recovery}`);
  const port = String(validPort(portMatch[1]));
  const panelPath = normalizeWebPath(pathMatch[1]);
  if (port !== String(validPort(values.PANEL_PORT)) || panelPath !== normalizeWebPath(values.WEB_BASE_PATH)) throw new Error(`官方安装结果与当前配置不一致，拒绝返回过期登录信息。${recovery}`);
  let url: URL;
  try { url = new URL(values.ACCESS_URL); } catch { throw new Error(`官方访问地址无效。${recovery}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || String(url.port || (url.protocol === 'https:' ? 443 : 80)) !== port || normalizeWebPath(url.pathname) !== panelPath) throw new Error(`官方访问地址与当前配置不一致。${recovery}`);
  const webCertFile = certMatch[1].trim(), webKeyFile = keyMatch[1].trim();
  if (Boolean(webCertFile) !== Boolean(webKeyFile)) throw new Error(`官方证书配置不完整。${recovery}`);
  const protocol = webCertFile && webKeyFile ? 'https' as const : 'http' as const;
  url.protocol = `${protocol}:`; url.port = port; url.pathname = panelPath;
  return { username: values.USERNAME, password: values.PASSWORD, apiToken: values.API_TOKEN, port, path: panelPath, host: url.hostname, protocol, accessUrl: url.href, sslEnabled: protocol === 'https', webCertFile: webCertFile || undefined, webKeyFile: webKeyFile || undefined };
}
