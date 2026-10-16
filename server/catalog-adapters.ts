import { randomBytes } from "node:crypto";
import {
  connectSsh,
  execSsh,
  inspectServer,
  SshInput,
} from "./ssh.js";
import {
  getPanelAdapter,
  PanelAdapter,
  PanelAdapterContext,
  PanelAdapterMetadata,
  registerPanelAdapter,
} from "./panel-adapters.js";
import { buildDockerInstallCommand } from "./panelark-remote.js";
import { shellQuote } from "./ssh.js";
import { cleanHostInput, optionalString, validPort } from "./validation.js";

export interface CatalogAdapterDependencies {
  connect?: typeof connectSsh;
  inspect?: typeof inspectServer;
  exec?: typeof execSsh;
}

export interface CatalogAdapterDefinition {
  metadata: PanelAdapterMetadata;
  installCommand: string | ((payload: Record<string, any>, useSudo: boolean, environment: Record<string, any>) => string);
  verifyCommand: string | ((payload: Record<string, any>, environment: Record<string, any>) => string);
  verifyOutput?: RegExp;
  accessProtocol?: "http" | "https";
  exposeAccessUrl?: boolean;
  requiredCommands?: string[];
  compatibility?: (environment: Record<string, any>) => string | undefined;
  result?: (payload: Record<string, any>, host: string, verification: string) => Record<string, unknown>;
}

function packageInstall(environment: Record<string, any>, packageName: string, serviceName?: string, epel = false) {
  const manager = String(environment.packageManager || "");
  let command: string;
  if (manager === "apt") command = `env DEBIAN_FRONTEND=noninteractive apt-get update -y && env DEBIAN_FRONTEND=noninteractive apt-get install -y ${packageName}`;
  else if (manager === "dnf" || manager === "yum") command = `${epel ? `${manager} install -y epel-release && ` : ""}${manager} install -y ${packageName}`;
  else throw new Error(`当前系统的包管理器 ${manager || "未知"} 不受支持`);
  return serviceName ? `${command} && systemctl enable --now ${serviceName}` : command;
}

function persistentContainer(name: string, createCommand: string) {
  return `if docker container inspect ${name} >/dev/null 2>&1; then docker start ${name} >/dev/null; else ${createCommand}; fi`;
}

function nezhaInstallCommand(payload: Record<string, any>) {
  const port = validPort(payload.servicePort, 8008);
  const host = cleanHostInput(payload.domain || payload.ipOrDomain || payload.host || payload.targetHost);
  if (!host) throw new Error("哪吒监控需要有效的服务器地址");
  const title = optionalString(payload.siteTitle) || "PanelArk Monitoring";
  const configLines = [
    "debug: false",
    `listen_port: ${port}`,
    "language: zh_CN",
    `site_name: ${JSON.stringify(title)}`,
    `install_host: ${JSON.stringify(`${host}:${port}`)}`,
    `tls: ${payload.sslEnabled === true && Boolean(payload.domain)}`,
  ];
  const writeConfig = `install -d -m 700 /opt/nezha/dashboard/data && printf '%s\\n' ${configLines.map(shellQuote).join(" ")} > /opt/nezha/dashboard/data/config.yaml`;
  const run = persistentContainer("nezha-dashboard", `docker run -d --name nezha-dashboard --restart=always -p ${port}:${port} -v /opt/nezha/dashboard/data:/dashboard/data ghcr.io/nezhahq/nezha:latest`);
  return `${writeConfig} && ${run}`;
}

function sUiInstallCommand(payload: Record<string, any>) {
  const port = validPort(payload.servicePort, 2095);
  const subscriptionPort = 30_000 + (randomBytes(2).readUInt16BE(0) % 30_000);
  const requestedUsername = optionalString(payload.panelUsername);
  const requestedPassword = optionalString(payload.panelPassword);
  const username = /^[A-Za-z0-9_.@-]{3,64}$/.test(requestedUsername) ? requestedUsername : `admin_${randomBytes(4).toString("hex")}`;
  const password = requestedPassword.length >= 8 && requestedPassword.length <= 128 ? requestedPassword : `Sui_${randomBytes(12).toString("base64url")}`;
  const panelPath = `sui_${randomBytes(4).toString("hex")}`;
  const subscriptionPath = `sub_${randomBytes(4).toString("hex")}`;
  Object.assign(payload, { __sUiPort: port, __sUiPath: panelPath, __sUiSubscriptionPort: subscriptionPort, __sUiUsername: username, __sUiPassword: password });
  const answers = ["y", String(port), panelPath, String(subscriptionPort), subscriptionPath, "y", username, password];
  return `printf '%s\\n' ${answers.map(shellQuote).join(" ")} | SUI_LANG=en bash -c "$(curl -fLsS https://raw.githubusercontent.com/alireza0/s-ui/master/install.sh)"`;
}

function marzbanInstallCommand() {
  return [
    "installer=$(mktemp)",
    "install_log=$(mktemp)",
    "trap 'rm -f \"$installer\" \"$install_log\"' EXIT",
    "curl -fLsS https://github.com/Gozargah/Marzban-scripts/raw/master/marzban.sh -o \"$installer\"",
    "setsid bash \"$installer\" install >\"$install_log\" 2>&1 & installer_pid=$!",
    "ready=0",
    "for attempt in $(seq 1 120); do if docker ps --format '{{.Names}}' | grep -Eq 'marzban'; then ready=1; break; fi; if ! kill -0 \"$installer_pid\" 2>/dev/null; then wait \"$installer_pid\"; code=$?; tail -n 80 \"$install_log\"; exit \"$code\"; fi; sleep 5; done",
    "if [ \"$ready\" -ne 1 ]; then kill -TERM -- -\"$installer_pid\" 2>/dev/null || true; tail -n 80 \"$install_log\"; exit 1; fi",
    "kill -TERM -- -\"$installer_pid\" 2>/dev/null || true",
    "wait \"$installer_pid\" 2>/dev/null || true",
    "tail -n 20 \"$install_log\"",
  ].join("; ");
}

function onePanelInstallCommand(payload: Record<string, any>) {
  const port = validPort(payload.servicePort, 10086);
  const requestedUsername = optionalString(payload.panelUsername);
  const requestedPassword = optionalString(payload.panelPassword);
  const username = /^[A-Za-z0-9_.@-]{3,64}$/.test(requestedUsername) ? requestedUsername : `admin_${randomBytes(4).toString("hex")}`;
  const password = /^[A-Za-z0-9!@#$%*_,.?]{8,30}$/.test(requestedPassword)
    ? requestedPassword
    : `One_${randomBytes(10).toString("hex")}!`;
  const entrance = randomBytes(8).toString("hex");
  Object.assign(payload, { __onePanelPort: port, __onePanelEntrance: entrance, __onePanelUsername: username, __onePanelPassword: password });
  const environment = [
    "PANEL_NON_INTERACTIVE=true",
    `PANEL_INSTALL_DIR=${shellQuote("/opt")}`,
    `PANEL_PORT=${shellQuote(String(port))}`,
    `PANEL_ENTRANCE=${shellQuote(entrance)}`,
    `PANEL_USERNAME=${shellQuote(username)}`,
    `PANEL_PASSWORD=${shellQuote(password)}`,
  ].join(" ");
  return `env ${environment} bash -c "$(curl -fLsS https://resource.fit2cloud.com/1panel/package/v2/quick_start.sh)"`;
}

function aaPanelInstallCommand(payload: Record<string, any>) {
  const port = validPort(payload.servicePort, 31750);
  const requestedUsername = optionalString(payload.panelUsername);
  const requestedPassword = optionalString(payload.panelPassword);
  const username = /^[A-Za-z0-9_.@-]{3,64}$/.test(requestedUsername) ? requestedUsername : `admin_${randomBytes(4).toString("hex")}`;
  const password = requestedPassword.length >= 8 && requestedPassword.length <= 128 ? requestedPassword : `Aa_${randomBytes(12).toString("base64url")}`;
  const safePath = `ark_${randomBytes(8).toString("hex")}`;
  Object.assign(payload, { __aaPanelPort: port, __aaPanelPath: safePath, __aaPanelUsername: username, __aaPanelPassword: password });
  return [
    "installer=$(mktemp)",
    "trap 'rm -f \"$installer\"' EXIT",
    "curl -fLsS https://www.aapanel.com/script/install_panel_en.sh -o \"$installer\"",
    `env INSTALL_FORCE=true bash "$installer" -y --user ${shellQuote(username)} --password ${shellQuote(password)} --port ${shellQuote(String(port))} --safe-path ${shellQuote(safePath)} forum`,
  ].join(" && ");
}

function aaPanelVerifyCommand(payload: Record<string, any>) {
  const port = validPort(payload.__aaPanelPort, 31750);
  const safePath = optionalString(payload.__aaPanelPath);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(safePath)) throw new Error("aaPanel 安全入口未正确生成");
  const browserUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36";
  return [
    "if systemctl is-active bt 2>/dev/null; then :; elif test -x /etc/init.d/bt; then /etc/init.d/bt status; else exit 1; fi",
    `http_code=$(curl -k -sS -o /dev/null -w '%{http_code}' --max-time 20 -A ${shellQuote(browserUserAgent)} ${shellQuote(`https://127.0.0.1:${port}/${safePath}`)})`,
    "test \"$http_code\" = 200",
    "printf '\\nHTTP %s\\n' \"$http_code\"",
  ].join(" && ");
}

function steps() {
  return [
    { key: "preflight", title: "检查系统、资源与适配器要求" },
    { key: "install", title: "执行受控安装命令" },
    { key: "verify", title: "验证服务和版本结果" },
    { key: "result", title: "整理访问地址和支持说明" },
  ];
}

function metadata(base: Omit<PanelAdapterMetadata, "operations" | "steps" | "form">): PanelAdapterMetadata {
  return {
    ...base,
    operations: ["install"],
    form: [
      { key: "serverSessionId", label: "已确认的服务器会话", type: "text", required: true },
      { key: "installChannel", label: "安装通道", type: "select", options: [{ label: "官方稳定通道", value: "stable" }] },
    ],
    steps: { install: steps(), "create-node": [], "get-tls": [] },
  };
}

const panelBase = {
  kind: "panel" as const,
  enabled: true,
  supportLevel: "pending" as const,
  supportedSystems: ["Linux"],
  operations: ["install"] as const,
  capabilities: ["ssh-install", "service-verification"],
  requirements: { os: ["linux"], minRamMb: 512, systemd: true, network: true },
};

const toolBase = {
  kind: "tool" as const,
  enabled: true,
  supportLevel: "pending" as const,
  supportedSystems: ["Ubuntu/Debian", "RHEL family"],
  operations: ["install"] as const,
  capabilities: ["ssh-install", "service-verification"],
  requirements: { os: ["linux"], minRamMb: 512, systemd: true, network: true },
};

const definitions: CatalogAdapterDefinition[] = [
  {
    metadata: metadata({ ...panelBase, id: "s-ui", name: "S-UI", category: "代理面板", accent: "sage", version: "Stable", memory: "512 MB+", port: "2095", description: "轻量 Xray 面板，提供基础入站和用户管理能力。" }),
    installCommand: payload => sUiInstallCommand(payload),
    verifyCommand: "systemctl is-active s-ui",
    verifyOutput: /^active/m,
    accessProtocol: "http",
    requiredCommands: ["bash", "curl", "systemctl"],
    result: (payload, host) => ({
      accessUrl: `http://${host}:${payload.__sUiPort}/${payload.__sUiPath}/`,
      port: payload.__sUiPort,
      path: `/${payload.__sUiPath}/`,
      subscriptionPort: payload.__sUiSubscriptionPort,
      username: payload.__sUiUsername,
      password: payload.__sUiPassword,
    }),
  },
  {
    metadata: metadata({ ...panelBase, id: "marzban", name: "Marzban", category: "代理面板", accent: "gold", version: "Stable", memory: "1 GB+", port: "8000", description: "基于 FastAPI 和 Xray 的多用户代理面板。", supportedSystems: ["Ubuntu 20.04+", "Debian 11+"], requirements: { os: ["linux"], minRamMb: 1024, systemd: false, network: true } }),
    installCommand: () => marzbanInstallCommand(),
    verifyCommand: "docker ps --format '{{.Names}}' | grep -E 'marzban'",
    verifyOutput: /marzban/m,
    accessProtocol: "http",
    requiredCommands: ["bash", "curl", "setsid"],
    compatibility: environment => ["ubuntu", "debian"].includes(String(environment.osId || "").toLowerCase()) ? undefined : "Marzban 官方一键安装仅在 Ubuntu/Debian 上启用",
  },
  {
    metadata: metadata({ ...panelBase, id: "hiddify", name: "Hiddify Manager", category: "代理面板", accent: "violet", version: "Stable", memory: "1 GB+", port: "443", description: "面向多协议代理和订阅管理的统一面板。", supportedSystems: ["Ubuntu 22.04"], requirements: { os: ["ubuntu"], minRamMb: 1024, systemd: true, network: true } }),
    installCommand: "bash -c \"$(curl -fLsS https://i.hiddify.com/release)\"",
    verifyCommand: "systemctl is-active hiddify-panel",
    verifyOutput: /^active/m,
    accessProtocol: "https",
    requiredCommands: ["bash", "curl", "systemctl"],
    compatibility: environment => String(environment.osId || "").toLowerCase() === "ubuntu" && String(environment.osVersion || "").startsWith("22.04") ? undefined : "Hiddify Manager 当前仅允许安装到 Ubuntu 22.04 干净系统",
  },
  {
    metadata: metadata({ ...panelBase, id: "1panel", name: "1Panel", category: "服务器面板", accent: "gold", version: "v2 Stable", memory: "1 GB+", port: "10086", description: "面向网站、数据库和容器的 Linux 运维面板。", supportedSystems: ["Ubuntu 20.04+", "Debian 11+", "CentOS 7+"], requirements: { os: ["linux"], minRamMb: 1024, systemd: true, network: true } }),
    installCommand: payload => onePanelInstallCommand(payload),
    verifyCommand: "systemctl is-active 1panel-core && systemctl is-active 1panel-agent",
    verifyOutput: /^active/m,
    accessProtocol: "http",
    requiredCommands: ["bash", "curl", "systemctl"],
    result: (payload, host) => ({
      accessUrl: `http://${host}:${payload.__onePanelPort}/${payload.__onePanelEntrance}`,
      port: payload.__onePanelPort,
      path: `/${payload.__onePanelEntrance}`,
      username: payload.__onePanelUsername,
      password: payload.__onePanelPassword,
    }),
  },
  {
    metadata: metadata({ ...panelBase, id: "aapanel", name: "aaPanel", category: "建站面板", accent: "sage", version: "Latest", memory: "512 MB+ / 1 GB 可用磁盘", port: "31750", description: "适合网站、数据库和 Web 环境的运维面板。", supportedSystems: ["Ubuntu 22/24/26", "Debian 11/12/13", "CentOS 9+", "Rocky/Alma 8+"], requirements: { os: ["linux"], minRamMb: 512, minDiskMb: 1024, systemd: true, network: true } }),
    installCommand: payload => aaPanelInstallCommand(payload),
    verifyCommand: payload => aaPanelVerifyCommand(payload),
    verifyOutput: /(?:active|already running|running)[\s\S]*HTTP 200/i,
    accessProtocol: "https",
    requiredCommands: ["bash", "curl", "systemctl"],
    result: (payload, host) => ({
      accessUrl: `https://${host}:${payload.__aaPanelPort}/${payload.__aaPanelPath}`,
      port: payload.__aaPanelPort,
      path: `/${payload.__aaPanelPath}`,
      username: payload.__aaPanelUsername,
      password: payload.__aaPanelPassword,
    }),
  },
  {
    metadata: metadata({ ...panelBase, id: "casaos", name: "CasaOS", category: "家庭云面板", accent: "blue", version: "Stable", memory: "1 GB+ / 5 GB 可用磁盘", port: "80", description: "面向家庭服务器和 NAS 的轻量容器面板。", supportedSystems: ["Ubuntu 20.04+", "Debian 11+"], requirements: { os: ["linux"], minRamMb: 1024, minDiskMb: 5120, systemd: true, network: true } }),
    installCommand: "curl -fsSL https://get.casaos.io | bash",
    verifyCommand: "systemctl is-active casaos",
    verifyOutput: /^active/m,
    accessProtocol: "http",
    requiredCommands: ["bash", "curl", "systemctl"],
    compatibility: environment => ["ubuntu", "debian"].includes(String(environment.osId || "").toLowerCase()) ? undefined : "CasaOS 官方安装器仅在 Ubuntu/Debian 上启用",
  },
  {
    metadata: metadata({ ...panelBase, id: "portainer", name: "Portainer", category: "Docker 面板", accent: "blue", version: "CE LTS", memory: "512 MB+", port: "9443", description: "Docker 与容器环境的可视化管理平台。", supportedSystems: ["Docker Engine"], requirements: { os: ["linux"], minRamMb: 512, systemd: false, network: true }, capabilities: ["ssh-install", "docker", "container-verification"] }),
    installCommand: persistentContainer("portainer", "docker volume create portainer_data >/dev/null && docker run -d --name portainer --restart=always -p 8000:8000 -p 9443:9443 -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data portainer/portainer-ce:lts"),
    verifyCommand: "docker ps --format '{{.Names}}' | grep -E '^portainer$'",
    verifyOutput: /portainer/m,
    accessProtocol: "https",
    requiredCommands: ["docker"],
  },
  {
    metadata: metadata({ ...panelBase, id: "npm", name: "Nginx Proxy Manager", category: "Docker 面板", accent: "sage", version: "Latest", memory: "1 GB+", port: "81", description: "通过 Web 界面管理反向代理、证书和访问策略。", supportedSystems: ["Docker Engine"], requirements: { os: ["linux"], minRamMb: 1024, systemd: false, network: true }, capabilities: ["ssh-install", "docker", "proxy", "certificate"] }),
    installCommand: persistentContainer("npm", "docker volume create npm_data >/dev/null && docker volume create npm_letsencrypt >/dev/null && docker run -d --name npm --restart=always -p 80:80 -p 81:81 -p 443:443 -v npm_data:/data -v npm_letsencrypt:/etc/letsencrypt jc21/nginx-proxy-manager:latest"),
    verifyCommand: "docker ps --format '{{.Names}}' | grep -E '^npm$'",
    verifyOutput: /npm/m,
    accessProtocol: "http",
    requiredCommands: ["docker"],
    compatibility: environment => ["x86_64", "amd64", "aarch64", "arm64"].includes(String(environment.arch || "").toLowerCase()) ? undefined : "Nginx Proxy Manager 仅支持 amd64 或 arm64 架构",
  },
  {
    metadata: metadata({ ...panelBase, id: "nezha", name: "哪吒监控", category: "监控面板", accent: "rose", version: "Stable", memory: "512 MB+", port: "8008", description: "轻量服务器监控面板与 Agent 管理中心。", supportedSystems: ["Docker Engine"], requirements: { os: ["linux"], minRamMb: 512, systemd: false, network: true }, capabilities: ["ssh-install", "docker", "container-verification"] }),
    installCommand: payload => nezhaInstallCommand(payload),
    verifyCommand: "docker ps --format '{{.Names}}' | grep -E '^nezha-dashboard$'",
    verifyOutput: /nezha-dashboard/m,
    accessProtocol: "http",
    requiredCommands: ["docker"],
  },
  {
    metadata: metadata({ ...panelBase, id: "uptime-kuma", name: "Uptime Kuma", category: "监控面板", accent: "violet", version: "Latest", memory: "512 MB+", port: "3001", description: "自托管服务可用性监控和状态页。", supportedSystems: ["Docker Engine"], requirements: { os: ["linux"], minRamMb: 512, systemd: false, network: true }, capabilities: ["ssh-install", "docker", "health-check"] }),
    installCommand: persistentContainer("uptime-kuma", "docker volume create uptime_kuma >/dev/null && docker run -d --name uptime-kuma --restart=unless-stopped -p 3001:3001 -v uptime_kuma:/app/data louislam/uptime-kuma:2"),
    verifyCommand: "docker ps --format '{{.Names}}' | grep -E '^uptime-kuma$'",
    verifyOutput: /uptime-kuma/m,
    accessProtocol: "http",
    requiredCommands: ["docker"],
  },
  {
    metadata: metadata({ ...toolBase, id: "docker", name: "Docker Engine", category: "容器环境", accent: "blue", version: "Stable", memory: "512 MB+", port: "无需端口", description: "安装 Docker Engine 与 Compose 并完成版本验证。", capabilities: ["ssh-install", "runtime", "compose"] }),
    installCommand: (_payload, _useSudo, environment) => buildDockerInstallCommand(String(environment.packageManager || ""), false),
    verifyCommand: "docker version --format '{{.Server.Version}}'",
    verifyOutput: /\d+\.\d+/m,
    requiredCommands: ["systemctl"],
  },
  {
    metadata: metadata({ ...toolBase, id: "nginx", name: "Nginx", category: "Web 环境", accent: "sage", version: "Stable", memory: "128 MB+", port: "80 / 443", description: "安装 Nginx 并验证 systemd 服务。", capabilities: ["ssh-install", "web-server", "service-verification"] }),
    installCommand: (_payload, _useSudo, environment) => packageInstall(environment, "nginx", "nginx"),
    verifyCommand: "systemctl is-active nginx",
    verifyOutput: /^active/m,
    exposeAccessUrl: true,
    requiredCommands: ["systemctl"],
  },
  {
    metadata: metadata({ ...toolBase, id: "fail2ban", name: "Fail2Ban", category: "安全加固", accent: "rose", version: "Latest", memory: "128 MB+", port: "无需端口", description: "安装并验证 SSH 暴力破解防护服务。", capabilities: ["ssh-install", "security", "service-verification"] }),
    installCommand: (_payload, _useSudo, environment) => {
      const install = packageInstall(environment, "fail2ban", undefined, true);
      const journaldJail = "install -d -m 755 /etc/fail2ban/jail.d && printf '%s\\n' '[sshd]' 'enabled = true' 'backend = systemd' > /etc/fail2ban/jail.d/panelark-sshd.local";
      return `${install} && ${journaldJail} && systemctl enable fail2ban && systemctl restart fail2ban`;
    },
    verifyCommand: "systemctl is-active fail2ban",
    verifyOutput: /^active/m,
    requiredCommands: ["systemctl"],
  },
  {
    metadata: metadata({ ...toolBase, id: "bbr", name: "BBR 加速", category: "网络优化", accent: "gold", version: "Kernel", memory: "无需额外内存", port: "无需端口", description: "检测内核并启用 TCP BBR 拥塞控制。", capabilities: ["ssh-install", "kernel", "network"] }),
    installCommand: "modprobe tcp_bbr 2>/dev/null || true; grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control && printf '%s\\n' 'net.core.default_qdisc=fq' 'net.ipv4.tcp_congestion_control=bbr' > /etc/sysctl.d/99-panelark-bbr.conf && sysctl --system >/dev/null",
    verifyCommand: "sysctl -n net.ipv4.tcp_congestion_control",
    verifyOutput: /bbr/m,
    requiredCommands: ["sysctl"],
  },
  {
    metadata: metadata({ ...toolBase, id: "swap", name: "Swap", category: "系统优化", accent: "violet", version: "System", memory: "自动计算", port: "无需端口", description: "按内存和磁盘状态创建受控 Swap 空间。", capabilities: ["ssh-install", "memory", "rollback"] }),
    installCommand: "if ! test -e /swapfile; then dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none && chmod 600 /swapfile && mkswap /swapfile; fi && (swapon --show=NAME --noheadings | grep -Fx /swapfile >/dev/null || swapon /swapfile) && (grep -Eq '^/swapfile[[:space:]]+none[[:space:]]+swap' /etc/fstab || printf '%s\\n' '/swapfile none swap sw 0 0' >> /etc/fstab)",
    verifyCommand: "swapon --show",
    verifyOutput: /swapfile/m,
    requiredCommands: ["dd", "mkswap", "swapon"],
  },
  {
    metadata: metadata({ ...toolBase, id: "certbot", name: "SSL 证书工具", category: "Web 环境", accent: "gold", version: "Latest", memory: "128 MB+", port: "无需端口", description: "安装 Certbot 并验证 ACME 工具链；安装工具本身不占用端口。", capabilities: ["ssh-install", "certificate", "acme"] }),
    installCommand: (_payload, _useSudo, environment) => packageInstall(environment, "certbot", undefined, true),
    verifyCommand: "certbot --version",
    verifyOutput: /certbot\s+\d+/i,
    requiredCommands: ["systemctl"],
  },
];

class CatalogAdapter implements PanelAdapter {
  constructor(public readonly metadata: PanelAdapterMetadata, private readonly definition: CatalogAdapterDefinition, private readonly dependencies: CatalogAdapterDependencies = {}) {}

  async execute(operation: "install" | "create-node" | "get-tls", context: PanelAdapterContext) {
    if (operation !== "install") throw new Error(`${this.metadata.name} 仅支持安装任务`);
    const payload = context.payload as Record<string, any> & SshInput;
    const connect = this.dependencies.connect || connectSsh;
    const inspect = this.dependencies.inspect || inspectServer;
    const exec = this.dependencies.exec || execSsh;
    const host = cleanHostInput(payload.ipOrDomain || payload.host || payload.targetHost);
    if (!host) throw new Error("请输入有效的服务器地址");
    const ownsSession = !payload.sshSession;
    let session: Awaited<ReturnType<typeof connectSsh>> | undefined;
    try {
      const environment = await context.step("preflight", async () => {
        session = payload.sshSession || await connect(payload, { timeoutMs: 25_000 });
        const details = await inspect(session);
        const requirements = this.metadata.requirements;
        // VPS providers advertise nominal memory while Linux reports slightly
        // less after firmware/kernel reservations (a 1 GB plan is often 970–1000 MB).
        const minimumReportedRamMb = Math.ceil(requirements.minRamMb * 0.95);
        if (details.totalRamMb && details.totalRamMb < minimumReportedRamMb) throw new Error(`${this.metadata.name} 至少需要 ${requirements.minRamMb}MB 内存`);
        if (requirements.minDiskMb && details.diskFreeMb < requirements.minDiskMb) throw new Error(`${this.metadata.name} 至少需要 ${requirements.minDiskMb}MB 可用磁盘空间`);
        if (requirements.systemd && !details.systemdAvailable) throw new Error(`${this.metadata.name} 要求 systemd 作为 PID 1`);
        const compatibilityError = this.definition.compatibility?.(details as Record<string, any>);
        if (compatibilityError) throw new Error(compatibilityError);
        if (!details.isRoot) {
          const sudo = await exec(session.client, "sudo -n true", { timeoutMs: 10_000 });
          if (sudo.code !== 0) throw new Error("当前 SSH 用户不是 root，且没有免密 sudo 权限");
        }
        if (this.definition.requiredCommands?.length) {
          const required = this.definition.requiredCommands.join(" ");
          const check = await exec(session.client, `for command_name in ${required}; do command -v "$command_name" >/dev/null || { echo "$command_name"; exit 127; }; done`, { timeoutMs: 10_000 });
          if (check.code !== 0) throw new Error(`${this.metadata.name} 缺少前置命令：${check.stdout.trim() || required}`);
        }
        context.progress(20, `${this.metadata.name} 环境检查通过`);
        return details;
      });
      await context.step("install", async () => {
        if (!session) throw new Error("SSH 会话未建立");
        const useSudo = !environment.isRoot;
        const command = typeof this.definition.installCommand === "function" ? this.definition.installCommand(payload, useSudo, environment as Record<string, any>) : this.definition.installCommand;
        const elevatedCommand = useSudo ? `sudo -n sh -c ${shellQuote(command)}` : command;
        const result = await exec(session.client, elevatedCommand, { timeoutMs: 20 * 60_000 });
        if (result.code !== 0) throw new Error(`${this.metadata.name} 安装失败：${(result.stderr || result.stdout).slice(-500)}`);
        context.progress(60, `${this.metadata.name} 安装命令已完成`);
      });
      const verification = await context.step("verify", async () => {
        if (!session) throw new Error("SSH 会话未建立");
        const rawVerifyCommand = typeof this.definition.verifyCommand === "function"
          ? this.definition.verifyCommand(payload, environment as Record<string, any>)
          : this.definition.verifyCommand;
        const verifyCommand = environment.isRoot ? rawVerifyCommand : `sudo -n sh -c ${shellQuote(rawVerifyCommand)}`;
        const result = await exec(session.client, verifyCommand, { timeoutMs: 30_000 });
        if (result.code !== 0 || (this.definition.verifyOutput && !this.definition.verifyOutput.test(result.stdout))) throw new Error(`${this.metadata.name} 安装后验证失败`);
        context.progress(85, `${this.metadata.name} 服务验证通过`);
        return result.stdout.trim().slice(0, 200);
      });
      return context.step("result", async () => {
        const port = this.metadata.port.match(/^\d+/)?.[0];
        const accessUrl = port && (this.definition.accessProtocol || this.definition.exposeAccessUrl)
          ? `${this.definition.accessProtocol || "http"}://${host}:${port}`
          : undefined;
        const extra = this.definition.result?.(payload, host, verification) || {};
        return { adapterId: this.metadata.id, id: `${this.metadata.id}-${Date.now()}`, name: this.metadata.name, host, accessUrl, verification, supportLevel: this.metadata.supportLevel, supportedSystems: this.metadata.supportedSystems, ...extra };
      });
    } finally {
      if (ownsSession) session?.client.end?.();
    }
  }
}

export function registerCatalogAdapters(dependencies?: CatalogAdapterDependencies) {
  for (const definition of definitions) registerPanelAdapter(new CatalogAdapter(definition.metadata, definition, dependencies));
  return definitions.map(definition => getPanelAdapter(definition.metadata.id)!);
}

export function getCatalogAdapterDefinitions() {
  return definitions.map(definition => definition.metadata);
}
