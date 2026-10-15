import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { Response, Router } from "express";
import { PanelArkDatabase, DbRow } from "./panelark-db.js";
import { sha256 } from "./panelark-security.js";
import { connectSsh, execSsh, formatServerInspectionError, inspectServer, shellQuote, SshInput, SshSession } from "./ssh.js";
import { validPort } from "./validation.js";

const REMOTE_SESSION_TTL_MS = 20 * 60_000;
const RESTORE_SAFETY_MINUTES = 10;

type DependencyId = "curl" | "ca-certificates" | "tar" | "gzip" | "unzip" | "openssl" | "socat" | "iproute2";
type FirewallKind = "ufw" | "firewalld" | "nftables" | "iptables" | "none";

export interface DependencyState {
  id: DependencyId;
  label: string;
  installed: boolean;
  required: boolean;
}

export interface PortState {
  port: number;
  occupied: boolean;
  process: string;
  pid?: number;
  service?: string;
  raw: string;
}

interface RemoteSession {
  id: string;
  grantHash: string;
  ssh: SshSession;
  confirmed: boolean;
  expiresAt: number;
  timer: NodeJS.Timeout;
  observedServices: Set<string>;
}

interface RestoreRecord {
  token: string;
  sessionId: string;
  grantHash: string;
  service: string;
  safetyUnit: string;
  wasActive: boolean;
}

const dependencyDefinitions: Array<{ id: DependencyId; label: string; check: string; apt: string; rpm: string }> = [
  { id: "curl", label: "curl 下载工具", check: "command -v curl >/dev/null", apt: "curl", rpm: "curl" },
  { id: "ca-certificates", label: "CA 根证书", check: "test -s /etc/ssl/certs/ca-certificates.crt || test -s /etc/pki/tls/certs/ca-bundle.crt", apt: "ca-certificates", rpm: "ca-certificates" },
  { id: "tar", label: "tar 解压工具", check: "command -v tar >/dev/null", apt: "tar", rpm: "tar" },
  { id: "gzip", label: "gzip 解压工具", check: "command -v gzip >/dev/null", apt: "gzip", rpm: "gzip" },
  { id: "unzip", label: "unzip 解压工具", check: "command -v unzip >/dev/null", apt: "unzip", rpm: "unzip" },
  { id: "openssl", label: "OpenSSL", check: "command -v openssl >/dev/null", apt: "openssl", rpm: "openssl" },
  { id: "socat", label: "socat 证书辅助工具", check: "command -v socat >/dev/null", apt: "socat", rpm: "socat" },
  { id: "iproute2", label: "ss 端口检测工具", check: "command -v ss >/dev/null", apt: "iproute2", rpm: "iproute" },
];

const processToService: Record<string, string> = {
  nginx: "nginx", apache2: "apache2", httpd: "httpd", caddy: "caddy", haproxy: "haproxy",
};

function markerMap(output: string) {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^__([A-Z0-9_]+)__=(.*)$/);
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

export function parseDependencyOutput(output: string): DependencyState[] {
  const values = markerMap(output);
  return dependencyDefinitions.map(item => ({
    id: item.id,
    label: item.label,
    installed: values.get(`DEP_${item.id.replace(/-/g, "_").toUpperCase()}`) === "yes",
    required: true,
  }));
}

export function parseFirewallOutput(output: string): { kind: FirewallKind; active: boolean; summary: string } {
  const values = markerMap(output);
  const candidate = values.get("FIREWALL") as FirewallKind | undefined;
  const kind: FirewallKind = ["ufw", "firewalld", "nftables", "iptables"].includes(candidate || "") ? candidate! : "none";
  return { kind, active: values.get("FIREWALL_ACTIVE") === "yes", summary: values.get("FIREWALL_SUMMARY") || (kind === "none" ? "未检测到本机防火墙" : "状态未知") };
}

export function parsePortScanOutput(output: string): PortState[] {
  const states: PortState[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^__PORT__=(\d+)\|(.*)$/);
    if (!match) continue;
    const port = Number(match[1]);
    const raw = match[2].trim().slice(0, 500);
    const processMatch = raw.match(/users:\(\(\"([^\"]+)\",pid=(\d+)/);
    const process = processMatch?.[1] || "";
    states.push({
      port,
      occupied: Boolean(raw),
      process,
      pid: processMatch ? Number(processMatch[2]) : undefined,
      service: processToService[process.toLowerCase()],
      raw,
    });
  }
  return states;
}

export function buildDependencyInstallCommand(packageManager: string, ids: string[], useSudo: boolean) {
  const selected = dependencyDefinitions.filter(item => ids.includes(item.id));
  if (!selected.length) throw new Error("没有可安装的依赖项");
  if (selected.length !== new Set(ids).size) throw new Error("依赖项不在安全允许列表中");
  const prefix = useSudo ? "sudo -n " : "";
  const packages = selected.map(item => packageManager === "apt" ? item.apt : item.rpm).join(" ");
  if (packageManager === "apt") return `${prefix}env DEBIAN_FRONTEND=noninteractive apt-get update -y && ${prefix}env DEBIAN_FRONTEND=noninteractive apt-get install -y ${packages}`;
  if (packageManager === "dnf") return `${prefix}dnf install -y ${packages}`;
  if (packageManager === "yum") return `${prefix}yum install -y ${packages}`;
  throw new Error("当前系统没有受支持的包管理器，无法自动安装依赖");
}

export function buildFirewallCommand(kind: FirewallKind, ports: number[], useSudo: boolean) {
  const prefix = useSudo ? "sudo -n " : "";
  if (kind === "ufw") return ports.map(port => `${prefix}ufw allow ${port}/tcp`).join(" && ");
  if (kind === "firewalld") return `${ports.map(port => `${prefix}firewall-cmd --permanent --add-port=${port}/tcp`).join(" && ")} && ${prefix}firewall-cmd --reload`;
  return "";
}

export function buildFirewallVerifyCommand(kind: FirewallKind, ports: number[], useSudo: boolean) {
  const prefix = useSudo ? "sudo -n " : "";
  if (kind === "ufw") return ports.map(port => `${prefix}ufw status | grep -Eq '^${port}/tcp[[:space:]]+ALLOW'`).join(" && ");
  if (kind === "firewalld") return ports.map(port => `${prefix}firewall-cmd --query-port=${port}/tcp`).join(" && ");
  return "";
}

export function buildDockerInstallCommand(packageManager: string, useSudo: boolean) {
  const prefix = useSudo ? "sudo -n " : "";
  const verify = "command -v docker >/dev/null && (docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1)";
  if (packageManager === "apt") {
    return `${prefix}env DEBIAN_FRONTEND=noninteractive apt-get update -y && ${prefix}env DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io && (${prefix}env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2 || ${prefix}env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin || ${prefix}env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose) && ${prefix}systemctl enable --now docker && ${verify}`;
  }
  if (packageManager === "dnf") {
    return `${prefix}dnf install -y dnf-plugins-core && ${prefix}dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo && ${prefix}dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin && ${prefix}systemctl enable --now docker && ${verify}`;
  }
  if (packageManager === "yum") {
    return `${prefix}yum install -y yum-utils && ${prefix}yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo && ${prefix}yum install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin && ${prefix}systemctl enable --now docker && ${verify}`;
  }
  throw new Error("当前系统没有受支持的 Docker 安装方案");
}

export function evaluateCompatibility(details: { osId: string; osVersion: string; arch: string; packageManager: string; systemdAvailable: boolean; isRoot: boolean }, canSudo: boolean) {
  const os = details.osId.toLowerCase();
  const version = Number.parseFloat(details.osVersion);
  const minimums: Record<string, number> = { ubuntu: 20.04, debian: 11, centos: 8, rocky: 8, almalinux: 8, alma: 8 };
  const reasons: string[] = [];
  if (!(os in minimums) || !Number.isFinite(version) || version < minimums[os]) reasons.push(`暂不支持 ${details.osId} ${details.osVersion}`);
  if (!details.systemdAvailable) reasons.push("系统未使用 systemd 作为 PID 1");
  if (!details.isRoot && !canSudo) reasons.push("当前账号不是 root 且没有免密 sudo 权限");
  if (!['apt', 'dnf', 'yum'].includes(details.packageManager)) reasons.push("未检测到受支持的包管理器");
  if (!['x86_64', 'amd64', 'aarch64', 'arm64'].includes(details.arch.toLowerCase())) reasons.push(`暂不支持 ${details.arch} 架构`);
  return { compatible: reasons.length === 0, reasons };
}

function sendError(response: Response, error: unknown, status = 400) {
  response.status(status).json({ success: false, error: error instanceof Error ? error.message : String(error) });
}

function requestedPorts(value: unknown): number[] {
  const source: unknown[] = Array.isArray(value) ? value : [];
  return [...new Set(source.map(port => validPort(port)))];
}

function privilegePrefix(details: { isRoot: boolean; canSudo: boolean }) {
  if (details.isRoot) return "";
  if (details.canSudo) return "sudo -n ";
  throw new Error("当前 SSH 用户既不是 root，也没有免密 sudo 权限");
}

function bestEffortPrivilegedShell(command: string, details: { isRoot: boolean; canSudo: boolean }) {
  return details.isRoot ? command : details.canSudo ? `sudo -n sh -c ${shellQuote(command)}` : command;
}

function dependencyCheckCommand() {
  return dependencyDefinitions.map(item => {
    const key = item.id.replace(/-/g, "_").toUpperCase();
    return `printf '__DEP_${key}__='; if ${item.check}; then echo yes; else echo no; fi`;
  }).join("; ");
}

function firewallCheckCommand() {
  return [
    "if command -v ufw >/dev/null; then fw=ufw; elif command -v firewall-cmd >/dev/null; then fw=firewalld; elif command -v nft >/dev/null; then fw=nftables; elif command -v iptables >/dev/null; then fw=iptables; else fw=none; fi; printf '__FIREWALL__=%s\\n' \"$fw\"",
    "printf '__FIREWALL_ACTIVE__='; if [ \"$fw\" = ufw ]; then ufw status 2>/dev/null | grep -qi '^Status: active' && echo yes || echo no; elif [ \"$fw\" = firewalld ]; then firewall-cmd --state 2>/dev/null | grep -q running && echo yes || echo no; elif [ \"$fw\" = nftables ]; then nft list ruleset 2>/dev/null | grep -q 'hook input' && echo yes || echo no; elif [ \"$fw\" = iptables ]; then iptables -S INPUT 2>/dev/null | grep -qv -- '-P INPUT ACCEPT' && echo yes || echo no; else echo no; fi",
    "printf '__FIREWALL_SUMMARY__=%s\\n' \"$fw\"",
  ].join("; ");
}

function dockerCheckCommand() {
  return [
    "printf '__DOCKER__='; command -v docker >/dev/null && echo yes || echo no",
    "printf '__DOCKER_COMPOSE__='; if docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1; then echo yes; else echo no; fi",
    "printf '__DOCKER_VERSION__='; docker --version 2>/dev/null | head -n1",
  ].join("; ");
}

function portScanCommand(ports: number[]) {
  const list = ports.join(" ");
  return `for p in ${list}; do line=$(ss -H -ltnp 2>/dev/null | awk -v needle=\":$p\" '$4 ~ needle\"$\" {print; exit}'); printf '__PORT__=%s|%s\\n' \"$p\" \"$line\"; done`;
}

async function canUseSudo(session: SshSession) {
  if (session.user === "root") return true;
  const result = await execSsh(session.client, "sudo -n true", { timeoutMs: 8_000 });
  return result.code === 0;
}

async function publicProbe(host: string, port: number, timeoutMs = 2500) {
  return new Promise<boolean>(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function mountPanelArkRemoteApi(router: Router, db: PanelArkDatabase) {
  const sessions = new Map<string, RemoteSession>();
  const restoreRecords = new Map<string, RestoreRecord>();

  const authorizeGrant = (grantToken: unknown) => {
    const token = typeof grantToken === "string" ? grantToken.trim() : "";
    if (!token) throw new Error("请先验证 CDK");
    const grantHash = sha256(token);
    const grant = db.get<DbRow>(
      "SELECT id, status, expires_at FROM cdk_grants WHERE token_hash = ? AND status IN ('validated','locked')",
      [grantHash],
    );
    if (!grant || String(grant.expires_at) <= new Date().toISOString()) throw new Error("CDK 授权已失效，请重新验证");
    return grantHash;
  };

  const removeSession = (id: string) => {
    const current = sessions.get(id);
    if (!current) return;
    clearTimeout(current.timer);
    current.ssh.client.end();
    sessions.delete(id);
  };

  const touchSession = (session: RemoteSession) => {
    clearTimeout(session.timer);
    session.expiresAt = Date.now() + REMOTE_SESSION_TTL_MS;
    session.timer = setTimeout(() => removeSession(session.id), REMOTE_SESSION_TTL_MS);
    session.timer.unref();
  };

  const getSession = (grantToken: unknown, sessionId: unknown, requireConfirmed = true) => {
    const grantHash = authorizeGrant(grantToken);
    const id = typeof sessionId === "string" ? sessionId : "";
    const session = sessions.get(id);
    if (!session || session.grantHash !== grantHash || !session.ssh.alive || session.expiresAt <= Date.now()) {
      if (session) removeSession(id);
      throw new Error("服务器安全会话已失效，请重新连接");
    }
    if (requireConfirmed && !session.confirmed) throw new Error("请先确认服务器主机指纹");
    touchSession(session);
    return session;
  };

  router.post("/server/connect", async (req, res) => {
    try {
      const grantHash = authorizeGrant(req.body?.grantToken);
      const input = req.body?.connection as SshInput;
      const ssh = await connectSsh(input, { timeoutMs: 18_000 });
      const id = randomUUID();
      const session: RemoteSession = { id, grantHash, ssh, confirmed: false, expiresAt: 0, timer: setTimeout(() => undefined, 1), observedServices: new Set() };
      touchSession(session);
      sessions.set(id, session);
      res.json({ success: true, serverSessionId: id, host: ssh.host, port: ssh.port, user: ssh.user, fingerprint: ssh.fingerprint, latencyMs: ssh.latencyMs, expiresInMinutes: REMOTE_SESSION_TTL_MS / 60_000 });
    } catch (error) { sendError(res, error); }
  });

  router.post("/server/inspect", async (req, res) => {
    try {
      const session = getSession(req.body?.grantToken, req.body?.serverSessionId, false);
      const fingerprint = typeof req.body?.fingerprint === "string" ? req.body.fingerprint.trim() : "";
      if (fingerprint !== session.ssh.fingerprint) throw new Error("主机指纹不匹配，请重新连接并核对服务器");
      session.confirmed = true;
      let base;
      try { base = await inspectServer(session.ssh, { timeoutMs: 15_000 }); }
      catch (error) { throw new Error(formatServerInspectionError(error)); }
      const canSudo = await canUseSudo(session.ssh);
      const firewallCommand = bestEffortPrivilegedShell(firewallCheckCommand(), { isRoot: base.isRoot, canSudo });
      const extended = await execSsh(session.ssh.client, `${dependencyCheckCommand()}; ${dockerCheckCommand()}; ${firewallCommand}`, { timeoutMs: 15_000 });
      if (extended.code !== 0) throw new Error(extended.stderr || "无法完成依赖与防火墙检测");
      const dependencies = parseDependencyOutput(extended.stdout);
      const firewall = parseFirewallOutput(extended.stdout);
      const extendedValues = markerMap(extended.stdout);
      const docker = { installed: extendedValues.get("DOCKER") === "yes", composeInstalled: extendedValues.get("DOCKER_COMPOSE") === "yes", version: extendedValues.get("DOCKER_VERSION") || "" };
      const missingDependencies = dependencies.filter(item => !item.installed);
      const compatibility = evaluateCompatibility(base, canSudo);
      const warnings = base.warnings.filter(item => !item.includes("免密 sudo"));
      if (!base.isRoot && canSudo) warnings.push("当前使用非 root 账号，后续受控操作将通过免密 sudo 执行。");
      res.json({
        success: true,
        details: { ...base, canSudo, dependencies, missingDependencies, docker, firewall, compatibility, warnings, status: compatibility.compatible ? (warnings.length ? "warning" : "compatible") : "incompatible", fingerprintConfirmed: true },
      });
    } catch (error) { sendError(res, error); }
  });

  router.post("/server/dependencies/install", async (req, res) => {
    try {
      const session = getSession(req.body?.grantToken, req.body?.serverSessionId);
      const ids = Array.isArray(req.body?.dependencyIds) ? req.body.dependencyIds.map(String) : [];
      const info = await inspectServer(session.ssh, { timeoutMs: 12_000 });
      const canSudo = await canUseSudo(session.ssh);
      const command = buildDependencyInstallCommand(info.packageManager, ids, !info.isRoot && canSudo);
      const install = await execSsh(session.ssh.client, command, { timeoutMs: 8 * 60_000 });
      if (install.code !== 0) throw new Error(`依赖安装失败：${(install.stderr || install.stdout).slice(-600)}`);
      const verify = await execSsh(session.ssh.client, dependencyCheckCommand(), { timeoutMs: 15_000 });
      const dependencies = parseDependencyOutput(verify.stdout);
      const failed = dependencies.filter(item => ids.includes(item.id) && !item.installed);
      if (failed.length) throw new Error(`依赖二次验证失败：${failed.map(item => item.label).join("、")}`);
      res.json({ success: true, dependencies, installed: ids });
    } catch (error) { sendError(res, error); }
  });

  router.post("/server/docker/install", async (req, res) => {
    try {
      if (req.body?.confirmed !== true) throw new Error("安装 Docker 与 Compose 需要明确确认");
      const session = getSession(req.body?.grantToken, req.body?.serverSessionId);
      const info = await inspectServer(session.ssh, { timeoutMs: 12_000 });
      const canSudo = await canUseSudo(session.ssh);
      const command = buildDockerInstallCommand(info.packageManager, !info.isRoot && canSudo);
      const install = await execSsh(session.ssh.client, command, { timeoutMs: 10 * 60_000 });
      if (install.code !== 0) throw new Error(`Docker 安装或验证失败：${(install.stderr || install.stdout).slice(-700)}`);
      const verify = await execSsh(session.ssh.client, dockerCheckCommand(), { timeoutMs: 20_000 });
      const values = markerMap(verify.stdout);
      const docker = { installed: values.get("DOCKER") === "yes", composeInstalled: values.get("DOCKER_COMPOSE") === "yes", version: values.get("DOCKER_VERSION") || "" };
      if (!docker.installed || !docker.composeInstalled) throw new Error("Docker 或 Compose 二次验证未通过");
      res.json({ success: true, docker });
    } catch (error) { sendError(res, error); }
  });

  router.post("/server/ports/check", async (req, res) => {
    try {
      const session = getSession(req.body?.grantToken, req.body?.serverSessionId);
      const ports = requestedPorts(req.body?.ports);
      if (!ports.length || ports.length > 20) throw new Error("每次需要检测 1 到 20 个端口");
      const base = await inspectServer(session.ssh, { timeoutMs: 12_000 });
      const canSudo = await canUseSudo(session.ssh);
      const command = bestEffortPrivilegedShell(portScanCommand(ports), { isRoot: base.isRoot, canSudo });
      const result = await execSsh(session.ssh.client, command, { timeoutMs: 15_000 });
      if (result.code !== 0) throw new Error(result.stderr || "端口占用检测失败");
      const items = parsePortScanOutput(result.stdout);
      for (const item of items) if (item.service) session.observedServices.add(item.service);
      res.json({ success: true, items });
    } catch (error) { sendError(res, error); }
  });

  router.post("/server/firewall/open", async (req, res) => {
    try {
      const session = getSession(req.body?.grantToken, req.body?.serverSessionId);
      const ports = requestedPorts(req.body?.ports);
      if (!ports.length || ports.length > 20) throw new Error("每次需要放行 1 到 20 个端口");
      const base = await inspectServer(session.ssh, { timeoutMs: 12_000 });
      const canSudo = await canUseSudo(session.ssh);
      const firewallResult = await execSsh(session.ssh.client, bestEffortPrivilegedShell(firewallCheckCommand(), { isRoot: base.isRoot, canSudo }), { timeoutMs: 12_000 });
      const firewall = parseFirewallOutput(firewallResult.stdout);
      let localAction: "opened" | "not_required" | "manual_required" = "not_required";
      if (firewall.active) {
        const command = buildFirewallCommand(firewall.kind, ports, !base.isRoot && canSudo);
        if (!command) localAction = "manual_required";
        else {
          const opened = await execSsh(session.ssh.client, command, { timeoutMs: 45_000 });
          if (opened.code !== 0) throw new Error(`本机防火墙放行失败：${(opened.stderr || opened.stdout).slice(-500)}`);
          const verifyCommand = buildFirewallVerifyCommand(firewall.kind, ports, !base.isRoot && canSudo);
          const verified = await execSsh(session.ssh.client, verifyCommand, { timeoutMs: 20_000 });
          if (verified.code !== 0) throw new Error("防火墙命令已执行，但规则二次验证未通过");
          localAction = "opened";
        }
      }
      const probes = await Promise.all(ports.map(async port => ({ port, reachable: await publicProbe(session.ssh.host, port) })));
      res.json({
        success: true, firewall, localAction, probes,
        cloudSecurityGroupRequired: probes.some(item => !item.reachable),
        message: probes.some(item => !item.reachable)
          ? "本机防火墙已处理，但公网探测仍不可达。若服务尚未启动请在安装后重试，否则请到 VPS 厂商安全组放行端口。"
          : "公网端口探测可达。",
      });
    } catch (error) { sendError(res, error); }
  });

  router.post("/server/service/temporary-stop", async (req, res) => {
    try {
      const session = getSession(req.body?.grantToken, req.body?.serverSessionId);
      const service = typeof req.body?.service === "string" ? req.body.service.trim() : "";
      if (!/^[a-zA-Z0-9@_.-]{1,80}$/.test(service) || !session.observedServices.has(service)) throw new Error("只能临时停止刚刚通过端口检测识别出的服务");
      const base = await inspectServer(session.ssh, { timeoutMs: 12_000 });
      const canSudo = await canUseSudo(session.ssh);
      const prefix = privilegePrefix({ isRoot: base.isRoot, canSudo });
      const token = randomBytes(24).toString("base64url");
      const safetyUnit = `panelark-restore-${randomBytes(6).toString("hex")}`;
      const safeService = shellQuote(service);
      const script = [
        `${prefix}systemctl is-active --quiet ${safeService}`,
        `${prefix}systemd-run --quiet --unit=${safetyUnit} --on-active=${RESTORE_SAFETY_MINUTES}m /bin/systemctl start ${safeService}`,
        `${prefix}systemctl stop ${safeService}`,
        `! ${prefix}systemctl is-active --quiet ${safeService}`,
      ].join(" && ");
      const stopped = await execSsh(session.ssh.client, script, { timeoutMs: 30_000 });
      if (stopped.code !== 0) throw new Error(`无法安全地临时停止 ${service}：${(stopped.stderr || stopped.stdout).slice(-400)}`);
      restoreRecords.set(token, { token, sessionId: session.id, grantHash: session.grantHash, service, safetyUnit, wasActive: true });
      res.json({ success: true, restoreToken: token, service, safetyRestoreMinutes: RESTORE_SAFETY_MINUTES });
    } catch (error) { sendError(res, error); }
  });

  router.post("/server/service/restore", async (req, res) => {
    try {
      const session = getSession(req.body?.grantToken, req.body?.serverSessionId);
      const token = typeof req.body?.restoreToken === "string" ? req.body.restoreToken : "";
      const record = restoreRecords.get(token);
      if (!record || record.sessionId !== session.id || record.grantHash !== session.grantHash) throw new Error("服务恢复记录不存在或已失效");
      const base = await inspectServer(session.ssh, { timeoutMs: 12_000 });
      const canSudo = await canUseSudo(session.ssh);
      const prefix = privilegePrefix({ isRoot: base.isRoot, canSudo });
      const service = shellQuote(record.service);
      const command = `${prefix}systemctl start ${service} && ${prefix}systemctl is-active --quiet ${service}`;
      const restored = await execSsh(session.ssh.client, command, { timeoutMs: 30_000 });
      if (restored.code !== 0) throw new Error(`服务 ${record.service} 恢复验证失败，请立即登录服务器检查`);
      await execSsh(session.ssh.client, `${prefix}systemctl stop ${record.safetyUnit}.timer >/dev/null 2>&1 || true; ${prefix}systemctl reset-failed ${record.safetyUnit}.service >/dev/null 2>&1 || true`, { timeoutMs: 15_000 });
      restoreRecords.delete(token);
      res.json({ success: true, service: record.service, restored: record.wasActive });
    } catch (error) { sendError(res, error); }
  });

  router.post("/server/disconnect", (req, res) => {
    try {
      const session = getSession(req.body?.grantToken, req.body?.serverSessionId, false);
      removeSession(session.id);
      res.json({ success: true });
    } catch (error) { sendError(res, error); }
  });

  // Adapter jobs may reuse the already-confirmed SSH channel without ever
  // serializing the user's password or private key into the job database.
  const getSshSession = (grantToken: unknown, sessionId: unknown) => getSession(grantToken, sessionId).ssh;
  return { getSshSession };
}
