import { randomBytes, randomInt } from 'node:crypto';
import { execSsh, inspectServer, shellQuote, type SshSession } from './ssh.js';
import { catalogCompatibility } from './catalog-adapters.js';
import { automaticCredentials, initializeAutomaticAccount } from './automatic-accounts.js';
import type { PanelAdapter, PanelAdapterContext } from './panel-adapters.js';
import { buildDependencyInstallCommand, buildFirewallCommand, buildFirewallVerifyCommand, canUseSudo, dependencyCheckCommand, evaluateCompatibility, firewallCheckCommand, parseDependencyOutput, parseFirewallOutput, parsePortScanOutput, portScanCommand } from './panelark-remote.js';

export const automaticSteps = [{ key: 'automatic-prepare', title: '自动检查环境、安装依赖并分配端口' }];
export const automaticFinalSteps = [{ key: 'automatic-network', title: '自动放行实际服务端口并核验交付信息' }];

export async function executeAutomaticDeployment(adapter: PanelAdapter, payload: Record<string, any>, context: PanelAdapterContext, dependencies: {
  inspect?: typeof inspectServer; exec?: typeof execSsh; sudo?: typeof canUseSudo; onDelivery?: (result: Record<string, unknown>) => void;
} = {}): Promise<Record<string, unknown>> {
  const exec = dependencies.exec || execSsh, inspect = dependencies.inspect || inspectServer;
  const session = payload.sshSession as SshSession;
  if (!session?.alive) throw new Error('SSH 安全会话已失效，请重新填写服务器信息');
  const details = await inspect(session);
  const canSudo = await (dependencies.sudo || canUseSudo)(session);
  const elevate = (command: string) => details.isRoot ? command : `sudo -n sh -c ${shellQuote(command)}`;
  const run = async (command: string, timeoutMs = 30_000) => {
    context.checkCancelled();
    const result = await exec(session.client, command, { timeoutMs });
    if (result.code !== 0) throw new Error(`自动准备失败：${(result.stderr || result.stdout || `退出码 ${result.code}`).slice(-500)}`);
    return result.stdout;
  };
  let ports: number[] = [];
  const openFirewall = async () => {
    if (!ports.length) return;
    const firewall = parseFirewallOutput(await run(elevate(firewallCheckCommand())));
    if (!firewall.active) return;
    const command = buildFirewallCommand(firewall.kind, ports, !details.isRoot);
    if (!command) throw new Error(`当前 ${firewall.kind} 防火墙规则无法安全自动修改，请由服务器管理员放行端口 ${ports.join('、')} 后重试；未停止现有服务`);
    await run(command, 60_000);
    await run(buildFirewallVerifyCommand(firewall.kind, ports, !details.isRoot));
    context.log('已自动放行本机防火墙并验证规则');
  };
  await context.step('automatic-prepare', async () => {
    const compatibility = evaluateCompatibility(details, canSudo);
    if (!compatibility.compatible) throw new Error(compatibility.reasons.join('；'));
    const requirements = adapter.metadata.requirements;
    if (details.totalRamMb && details.totalRamMb < Math.ceil(requirements.minRamMb * .95)) throw new Error(`${adapter.metadata.name} 至少需要 ${requirements.minRamMb}MB 内存，请升级服务器配置`);
    if (requirements.minDiskMb && details.diskFreeMb < requirements.minDiskMb) throw new Error(`至少需要 ${requirements.minDiskMb}MB 可用磁盘，请清理空间或扩容后重试`);
    const arch = ({ x86_64: 'amd64', aarch64: 'arm64' } as Record<string, string>)[details.arch] || details.arch;
    if (requirements.architectures?.length && !requirements.architectures.includes(arch)) throw new Error(`当前 ${details.arch} 架构不支持此项目，请使用 ${requirements.architectures.join('/')} 服务器`);
    const error = catalogCompatibility(adapter.metadata.id, details);
    if (error) throw new Error(error);
    if (adapter.metadata.id === '3x-ui') {
      const existing = await run('if command -v x-ui >/dev/null || test -d /usr/local/x-ui; then echo existing-x-ui; fi');
      if (existing.includes('existing-x-ui')) throw new Error('服务器已安装 x-ui，自动安装不会覆盖已有面板；请使用现有登录入口或先备份迁移');
    }
    const container = ({ 'new-api': 'panelark-new-api', 'one-api': 'panelark-one-api', cliproxyapi: 'panelark-cliproxyapi', portainer: 'portainer', npm: 'npm', nezha: 'nezha-dashboard', 'uptime-kuma': 'uptime-kuma' } as Record<string, string>)[adapter.metadata.id];
    if (container) {
      const existing = await run(elevate(`if command -v docker >/dev/null && docker container inspect ${container} >/dev/null 2>&1; then echo existing-panel; fi`));
      if (existing.includes('existing-panel')) throw new Error('该项目已安装，自动部署不会重复覆盖；请使用已有面板登录信息');
    }
    const existingDirectory = ({ marzban: '/opt/marzban', hiddify: '/opt/hiddify-manager', casaos: '/var/lib/casaos', 's-ui': '/usr/local/s-ui', '1panel': '/opt/1panel' } as Record<string, string>)[adapter.metadata.id];
    if (existingDirectory && (await run(elevate(`if test -d ${shellQuote(existingDirectory)}; then echo existing-panel; fi`))).includes('existing-panel')) throw new Error('检测到已有项目或安装残留，未覆盖现有数据；请先备份检查，或使用干净服务器');
    const missing = parseDependencyOutput(await run(dependencyCheckCommand())).filter(item => !item.installed);
    if (missing.length) {
      context.log(`正在自动安装基础依赖：${missing.map(item => item.label).join('、')}`);
      await run(buildDependencyInstallCommand(details.packageManager, missing.map(item => item.id), !details.isRoot), 8 * 60_000);
      if (parseDependencyOutput(await run(dependencyCheckCommand())).some(item => !item.installed)) throw new Error('基础依赖自动安装后验证失败，请检查系统软件源和网络后重试');
    }
    const configurable = ['3x-ui', 'new-api', 'one-api', 'cliproxyapi'].includes(adapter.metadata.id);
    let main = adapter.metadata.id === '3x-ui' ? randomInt(20000, 50000) : Number(adapter.metadata.port.match(/^\d+/)?.[0] || 0);
    const callbacks = adapter.metadata.id === 'cliproxyapi' ? [8085, 1455, 54545, 51121, 11451] : adapter.metadata.id === 'npm' || adapter.metadata.id === 'hiddify' ? [80, 443] : [];
    for (let attempt = 0; attempt < 30; attempt++) {
      const candidates = configurable ? [main] : (adapter.metadata.port.match(/\d+/g) || []).map(Number);
      const occupied = candidates.length ? parsePortScanOutput(await run(elevate(portScanCommand(candidates)))).filter(item => item.occupied) : [];
      if (!occupied.length && (!configurable || !callbacks.includes(main))) { ports = candidates; break; }
      if (!configurable || attempt === 29) throw new Error(`端口 ${occupied.map(item => item.port).join('、')} 已被现有服务占用；未停止原服务，请迁移冲突服务或使用干净服务器重试`);
      main = randomInt(20000, 50000);
    }
    if (configurable) { payload.servicePort = main; if (adapter.metadata.id === '3x-ui') { payload.panelPort = main; payload.autoSSL = true; payload.scriptType = 'official'; } }
    ports = [...new Set([...ports, ...callbacks, ...(adapter.metadata.id === '3x-ui' ? [80, 443] : [])])];
    const fixed = [...callbacks, ...(adapter.metadata.id === '3x-ui' ? [80, 443] : [])];
    if (fixed.length) {
      const conflict = parsePortScanOutput(await run(elevate(portScanCommand(fixed)))).find(item => item.occupied);
      if (conflict) throw new Error(`安装所需固定端口 ${conflict.port} 被 ${conflict.process || '已有服务'} 占用；请迁移该服务或使用干净服务器，系统不会中断已有业务`);
    }
    await openFirewall();
    context.progress(12, '环境与端口已自动准备，开始安装');
  });
  payload.__automaticCredentials = automaticCredentials();
  if (adapter.metadata.id === 'npm') payload.__automaticCredentials.username += '@panelark.local';
  const result = await adapter.execute('install', { ...context, payload }) as Record<string, unknown>;
  dependencies.onDelivery?.(result);
  return context.step('automatic-network', async () => {
    context.checkCancelled();
    if (['portainer', 'npm', 'uptime-kuma', 'casaos', 'marzban', 'nezha'].includes(adapter.metadata.id)) {
      const url = new URL(String(result.accessUrl));
      const readyUrl = `${url.protocol}//127.0.0.1:${url.port || 80}${adapter.metadata.id === 'portainer' ? '/api/status' : '/'}`;
      await run(`ready=0; for attempt in $(seq 1 45); do if curl -k -fsS --max-time 3 ${shellQuote(readyUrl)} -o /dev/null; then ready=1; break; fi; sleep 2; done; test "$ready" = 1`, 240000);
      await initializeAutomaticAccount(adapter.metadata.id, result, payload, run, elevate, value => dependencies.onDelivery?.(value));
    } else if (adapter.metadata.id === 'hiddify') await initializeAutomaticAccount(adapter.metadata.id, result, payload, run, elevate, value => dependencies.onDelivery?.(value));
    if (['new-api', 'one-api'].includes(adapter.metadata.id)) {
      const port = Number(result.port || payload.servicePort);
      const username = adapter.metadata.id === 'new-api' ? `ark_${randomBytes(4).toString('hex')}` : 'root';
      const password = `Ark_${randomBytes(12).toString('base64url')}!9`;
      const request = async (path: string, method = 'GET', body?: unknown, cookie = '') => {
        const raw = await run(`curl -fsS --max-time 25 -D - -X ${method} -H 'Content-Type: application/json' ${cookie ? `-H ${shellQuote(`Cookie: ${cookie}`)}` : ''} ${body ? `--data-binary ${shellQuote(JSON.stringify(body))}` : ''} ${shellQuote(`http://127.0.0.1:${port}${path}`)}`);
        const separator = raw.search(/\r?\n\r?\n/);
        const header = raw.slice(0, separator), content = raw.slice(separator).trim();
        const response = JSON.parse(content) as Record<string, any>;
        if (response.success !== true) throw new Error(`管理员自动初始化失败：${String(response.message || '官方接口未返回成功').slice(0, 300)}`);
        return { body: response, cookie: header.match(/^set-cookie:\s*([^;\r\n]+)/im)?.[1] || '' };
      };
      if (adapter.metadata.id === 'new-api') {
        const setup = await request('/api/setup');
        if (setup.body.data?.status || setup.body.data?.root_init) throw new Error('New API 已有管理员，系统不会覆盖原账号；请使用原有登录信息');
        await request('/api/setup', 'POST', { username, password, confirmPassword: password, SelfUseModeEnabled: true, DemoSiteEnabled: false });
      } else {
        const login = await request('/api/user/login', 'POST', { username: 'root', password: '123456' });
        await request('/api/user/self', 'PUT', { username, password, display_name: 'Administrator' }, login.cookie);
      }
      Object.assign(result, { username, password, installInfo: '管理员已自动创建／配置，无需网页安装向导。', nextStep: '直接使用返回的账号密码登录；模型渠道需使用你自己的上游 API 凭据配置。' });
      dependencies.onDelivery?.(result);
      await request('/api/user/login', 'POST', { username, password });
      context.log('管理员已自动配置，真实登录验证通过');
    }
    // Baota/aaPanel choose a security port themselves; use the actual delivery URL.
    if (typeof result.accessUrl === 'string') {
      const url = new URL(result.accessUrl);
      ports = [...new Set([...ports, Number(url.port || (url.protocol === 'https:' ? 443 : 80))])];
      await openFirewall();
    }
    if (Number(result.subscriptionPort)) { ports = [...new Set([...ports, Number(result.subscriptionPort)])]; await openFirewall(); }
    return { ...result, networkNotice: ports.length ? `本机防火墙已自动处理；若公网仍无法访问，请在云厂商安全组放行 TCP ${ports.join('、')}。` : undefined };
  });
}
