import { createHash } from "node:crypto";
import { Client, ConnectConfig, ClientChannel } from "ssh2";
import { cleanHostInput, requiredString, validPort } from "./validation.js";

export interface SshInput {
  ipOrDomain: string;
  sshPort?: number;
  sshUser?: string;
  authType?: "password" | "privateKey";
  sshPassword?: string;
  sshPrivateKey?: string;
  sshPrivateKeyPassphrase?: string;
}

export interface SshSession {
  client: Client;
  host: string;
  port: number;
  user: string;
  fingerprint: string;
  latencyMs: number;
  alive: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function formatSshConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error && "code" in error
    ? String((error as { code?: unknown }).code || "")
    : "";
  if (/authentication|all configured authentication methods failed/i.test(message)) {
    return "SSH 认证失败，请检查用户名、密码或私钥";
  }
  if (code === "ECONNREFUSED" || /connection refused/i.test(message)) {
    return "SSH 端口拒绝连接，请确认 SSH 服务和端口配置";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /getaddrinfo/i.test(message)) {
    return "无法解析服务器域名，请检查地址或 DNS";
  }
  if (code === "ETIMEDOUT" || /timed out|timeout/i.test(message)) {
    return "SSH 连接超时，请检查服务器安全组、防火墙和 SSH 端口";
  }
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || /host is unreachable|network is unreachable/i.test(message)) {
    return "SSH 服务器网络不可达，请检查公网 IP、路由和安全组";
  }
  return `SSH 连接失败: ${message}`;
}

export function formatServerInspectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/远程命令执行超时|timed out|timeout/i.test(message)) {
    return "SSH 已连接，但服务器系统检测未在规定时间内完成";
  }
  const cause = message
    .replace(/^无法执行远程命令:\s*/i, "")
    .replace(/^远程命令执行失败:\s*/i, "")
    .trim();
  return `SSH 已连接，但无法读取服务器系统环境${cause ? `：${cause.slice(0, 160)}` : ""}`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildInstallCommand(params: {
  scriptUrl: string;
  username: string;
  password: string;
  panelPort: number;
  webBasePath: string;
  serverIp: string;
  sslMode: "none" | "domain" | "ip";
  domain?: string;
  useSudo: boolean;
  interactiveAnswers?: string[];
  configurePanelAfterInstall?: boolean;
}): string {
  const env: Record<string, string> = {
    XUI_NONINTERACTIVE: "1",
    XUI_USERNAME: params.username,
    XUI_PASSWORD: params.password,
    XUI_PANEL_PORT: String(params.panelPort),
    XUI_WEB_BASE_PATH: params.webBasePath.replace(/^\/+|\/+$/g, ""),
    XUI_SERVER_IP: params.serverIp,
    XUI_SSL_MODE: params.sslMode,
    XUI_DB_TYPE: "sqlite",
    XUI_ENABLE_FAIL2BAN: "true",
  };
  if (params.domain) env.XUI_DOMAIN = params.domain;

  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const installer = params.interactiveAnswers
    ? [
        "installer=$(mktemp)",
        "trap 'rm -f \"$installer\"' EXIT",
        `curl -fLsS ${shellQuote(params.scriptUrl)} -o "$installer"`,
        `printf '%s\\n' ${params.interactiveAnswers.map(shellQuote).join(" ")} | bash "$installer"`,
      ].join(" && ")
    : `curl -fLsS ${shellQuote(params.scriptUrl)} | bash`;
  const panelPath = params.webBasePath.replace(/^\/+|\/+$/g, "");
  const configurePanel = params.configurePanelAfterInstall
    ? [
        "test -x /usr/local/x-ui/x-ui",
        "&& setting_output=$(/usr/local/x-ui/x-ui setting",
        `-username ${shellQuote(params.username)}`,
        `-password ${shellQuote(params.password)}`,
        `-port ${shellQuote(String(params.panelPort))}`,
        `-webBasePath ${shellQuote(panelPath)}`,
        "2>&1)",
        "&& printf '%s\\n' \"$setting_output\"",
        "&& printf '%s\\n' \"$setting_output\" | grep -q 'Username and password updated successfully'",
        "&& printf '%s\\n' \"$setting_output\" | grep -q 'Port set successfully:'",
        "&& printf '%s\\n' \"$setting_output\" | grep -q 'Base URI path set successfully'",
        "&& systemctl restart x-ui",
      ].join(" ")
    : "";
  const script = configurePanel ? `${installer} && ${configurePanel}` : installer;
  return `${params.useSudo ? "sudo -n " : ""}env ${assignments} bash -c ${shellQuote(script)}`;
}

export async function connectSsh(
  input: SshInput,
  options: { timeoutMs?: number } = {},
): Promise<SshSession> {
  const host = cleanHostInput(input.ipOrDomain);
  if (!host) throw new Error("请输入有效的服务器 IP 或域名");
  const port = validPort(input.sshPort, 22);
  const user = requiredString(input.sshUser || "root", "SSH 用户名");
  const authType = input.authType || "password";
  const timeoutMs = options.timeoutMs ?? 20_000;

  const config: ConnectConfig = {
    host,
    port,
    username: user,
    readyTimeout: timeoutMs,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
  };
  if (authType === "privateKey") {
    config.privateKey = requiredString(input.sshPrivateKey, "SSH 私钥");
    if (input.sshPrivateKeyPassphrase) config.passphrase = input.sshPrivateKeyPassphrase;
  } else {
    config.password = requiredString(input.sshPassword, "SSH 密码");
    config.tryKeyboard = true;
  }

  let fingerprint = "";
  config.hostVerifier = (key) => {
    fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
    return true;
  };

  const client = new Client();
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let session: SshSession | undefined;
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      reject(new Error(formatSshConnectionError(error)));
    };
    const timer = setTimeout(() => {
      finishError(Object.assign(new Error("Timed out while waiting for SSH handshake"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    client.once("ready", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session = { client, host, port, user, fingerprint, latencyMs: Date.now() - startedAt, alive: true };
      resolve(session);
    });
    client.on("error", (error) => {
      if (session) session.alive = false;
      finishError(error);
    });
    client.once("end", () => {
      if (session) session.alive = false;
      finishError(new Error("SSH 服务器在握手完成前关闭了连接"));
    });
    client.once("close", () => {
      if (session) session.alive = false;
      finishError(new Error("SSH 连接在握手完成前被关闭"));
    });
    if (authType === "password") {
      client.on("keyboard-interactive", (_name, _instructions, _language, prompts, finish) => {
        finish(prompts.map(() => config.password || ""));
      });
    }
    client.connect(config);
  });
}

export function execSsh(
  client: Client,
  command: string,
  options: { timeoutMs?: number; onStdout?: (text: string) => void; onStderr?: (text: string) => void } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stream: ClientChannel | undefined;
    let settled = false;
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream?.close();
      reject(error);
    };
    const timer = setTimeout(() => {
      finishError(new Error("远程命令执行超时"));
    }, options.timeoutMs ?? 30_000);

    client.exec(command, (error, channel) => {
      if (error) {
        finishError(new Error(`无法执行远程命令: ${error.message}`));
        return;
      }
      stream = channel;
      channel.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        options.onStdout?.(text);
      });
      channel.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        options.onStderr?.(text);
      });
      channel.once("close", (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? 0 });
      });
      channel.once("error", (streamError: Error) => {
        finishError(new Error(`远程命令失败: ${streamError.message}`));
      });
    });
  });
}

export function parseServerInspectionOutput(
  session: Pick<SshSession, "host" | "port" | "user" | "fingerprint" | "latencyMs">,
  output: string,
) {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^__([A-Z_]+)__=(.*)$/);
    if (match) values.set(match[1], match[2].trim());
  }
  const isRoot = values.get("UID") === "0";
  const systemdAvailable = values.get("SYSTEMD_ACTIVE") === "yes";
  const warnings: string[] = [];
  if (!isRoot) warnings.push("当前用户不是 root，部署时要求具备免密 sudo 权限。");
  if (values.get("CURL") !== "yes") warnings.push("服务器尚未安装 curl，安装脚本可能无法启动。");
  const totalRamMb = Math.round(Number(values.get("RAM_KB") || 0) / 1024);
  if (totalRamMb && totalRamMb < 512) warnings.push("服务器内存低于 512MB，建议先配置 Swap。");
  if (!systemdAvailable) warnings.push("当前系统未运行 systemd，无法安装依赖 systemd 的面板和服务。");
  return {
    targetHost: session.host,
    sshPort: session.port,
    sshUser: session.user,
    latencyMs: session.latencyMs,
    hostKeyFingerprint: session.fingerprint,
    osName: values.get("OS") || "Linux",
    osId: values.get("OS_ID") || "unknown",
    osVersion: values.get("OS_VERSION") || "unknown",
    arch: values.get("ARCH") || "unknown",
    kernel: values.get("KERNEL") || "unknown",
    glibcVersion: values.get("GLIBC") || "unknown",
    systemdVersion: values.get("SYSTEMD") || "unavailable",
    systemdAvailable,
    totalRamMb,
    freeRamMb: Math.round(Number(values.get("FREE_KB") || 0) / 1024),
    diskFreeMb: Math.round(Number(values.get("DISK_FREE_KB") || 0) / 1024),
    cpuCores: Number(values.get("CPU") || 1),
    packageManager: values.get("PKG_MANAGER") || "unknown",
    isRoot,
    hasCurl: values.get("CURL") === "yes",
    warnings,
    status: !systemdAvailable ? "incompatible" : warnings.length ? "warning" : "compatible",
  };
}

export async function inspectServer(
  session: SshSession,
  options: { timeoutMs?: number } = {},
) {
  const command = [
    "if [ -r /etc/os-release ]; then . /etc/os-release; fi; printf '__OS__=%s\\n' \"${PRETTY_NAME:-Linux}\"",
    "printf '__OS_ID__=%s\\n' \"${ID:-unknown}\"",
    "printf '__OS_VERSION__=%s\\n' \"${VERSION_ID:-unknown}\"",
    "printf '__ARCH__='; uname -m",
    "printf '__KERNEL__='; uname -sr",
    "printf '__GLIBC__='; ldd --version 2>/dev/null | head -n1",
    "printf '__SYSTEMD__='; systemctl --version 2>/dev/null | head -n1",
    "printf '__CPU__='; getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 1",
    "printf '__SYSTEMD_ACTIVE__='; if [ \"$(ps -p 1 -o comm= 2>/dev/null | tr -d ' ')\" = systemd ] && [ -d /run/systemd/system ]; then echo yes; else echo no; fi",
    "printf '__RAM_KB__='; awk '/MemTotal/{print $2}' /proc/meminfo",
    "printf '__FREE_KB__='; awk '/MemAvailable/{print $2}' /proc/meminfo",
    "printf '__DISK_FREE_KB__='; df -Pk / 2>/dev/null | awk 'NR==2 {print $4}'",
    "printf '__UID__='; id -u",
    "printf '__CURL__='; command -v curl >/dev/null && echo yes || echo no",
    "printf '__PKG_MANAGER__='; if command -v apt-get >/dev/null; then echo apt; elif command -v dnf >/dev/null; then echo dnf; elif command -v yum >/dev/null; then echo yum; else echo unknown; fi",
  ].join("; ");
  const result = await execSsh(session.client, command, { timeoutMs: options.timeoutMs ?? 12_000 });
  if (result.code !== 0) throw new Error(result.stderr || "无法读取服务器环境");
  return parseServerInspectionOutput(session, result.stdout);
}
