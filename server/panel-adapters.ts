import { randomBytes, randomUUID } from "node:crypto";
import { buildInbound, InboundInput } from "./inbound-builder.js";
import {
  buildInstallCommand,
  connectSsh,
  execSsh,
  inspectServer,
  parseServerInspectionOutput,
  SshInput,
} from "./ssh.js";
import {
  findInboundRecord,
  isRetryablePanelConnectionError,
  parseApiTokenFromOutput,
  XuiClient,
  XuiClientOptions,
} from "./xui-client.js";
import { injectSocksRouting, parseSocksInput } from "./xray-template.js";
import { cleanHostInput, normalizeWebPath, optionalString, panelPassword, panelUsername, randomToken, validPort } from "./validation.js";
import type { JobExecutionContext } from "./panelark-jobs.js";

export type PanelAdapterOperation = "install" | "create-node" | "get-tls";

export interface PanelFormField {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "select" | "switch" | "textarea";
  required?: boolean;
  secret?: boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface PanelAdapterMetadata {
  id: string;
  name: string;
  kind: "panel" | "tool";
  category: string;
  accent: "gold" | "sage" | "blue" | "rose" | "violet";
  version: string;
  memory: string;
  port: string;
  description: string;
  enabled: boolean;
  supportLevel: "verified" | "pending";
  supportedSystems: string[];
  operations: PanelAdapterOperation[];
  capabilities: string[];
  requirements: {
    os: string[];
    minRamMb: number;
    minDiskMb?: number;
    systemd: boolean;
    network: boolean;
    architectures?: string[];
    autoInstallDependencies?: string[];
  };
  form: PanelFormField[];
  steps: Record<PanelAdapterOperation, Array<{ key: string; title: string }>>;
}

export interface PanelAdapterContext extends JobExecutionContext {
  payload: Record<string, any>;
}

export interface PanelAdapter {
  metadata: PanelAdapterMetadata;
  execute(operation: PanelAdapterOperation, context: PanelAdapterContext): Promise<unknown>;
}

export interface ThreeXUiAdapterDependencies {
  connect?: typeof connectSsh;
  inspect?: typeof inspectServer;
  exec?: typeof execSsh;
  client?: (options: XuiClientOptions) => XuiClient;
  sleep?: (milliseconds: number) => Promise<void>;
}

const RECOMMENDED_INSTALLER = "https://raw.githubusercontent.com/wstimin/mogai-3xui/main/install.sh";
const OFFICIAL_INSTALLER = "https://raw.githubusercontent.com/MHSanaei/3x-ui/master/install.sh";

function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function sleep(milliseconds: number) { return new Promise<void>(resolve => setTimeout(resolve, milliseconds)); }

function parseInstallerResult(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^__XUI_([A-Z_]+)__=(.*)$/);
    if (match) values[match[1]] = match[2].trim();
  }
  return values;
}

function adapterSteps(operation: PanelAdapterOperation) {
  return operation === "install"
    ? [
        { key: "preflight", title: "检查服务器与适配器要求" },
        { key: "install", title: "安装 3x-ui 面板" },
        { key: "verify", title: "验证服务、登录和 API Token" },
        { key: "result", title: "整理面板访问结果" },
      ]
    : [
        { key: "preflight", title: "检查节点参数与面板凭证" },
        { key: "create", title: "创建 3x-ui 入站" },
        { key: "route", title: "写入可选 SOCKS 路由" },
        { key: "result", title: "生成节点链接和说明" },
      ];
}

export const threeXUiMetadata: PanelAdapterMetadata = {
  id: "3x-ui",
  name: "3x-ui",
  kind: "panel",
  category: "代理面板",
  accent: "blue",
  version: "1",
  memory: "512 MB+",
  port: "自动生成",
  description: "PanelArk 官方 3x-ui 适配器，负责面板安装、真实验证、节点和 SOCKS 路由。",
  enabled: true,
  supportLevel: "pending",
  supportedSystems: ["Ubuntu 20.04+", "Debian 11+", "CentOS/Rocky/Alma 8+"],
  operations: ["install", "create-node", "get-tls"],
  capabilities: ["ssh-install", "api-token", "tls-certificates", "vless", "vmess", "trojan", "shadowsocks", "reality", "socks-routing"],
  requirements: { os: ["linux"], minRamMb: 512, systemd: true, network: true },
  form: [
    { key: "scriptType", label: "安装脚本", type: "select", options: [{ label: "推荐兼容脚本", value: "recommended" }, { label: "官方脚本", value: "official" }, { label: "自定义 HTTPS 脚本", value: "custom" }] },
    { key: "panelPort", label: "面板端口", type: "number", required: true },
    { key: "panelPath", label: "面板路径", type: "text", required: true },
    { key: "panelUsername", label: "管理员用户名", type: "text", required: true },
    { key: "panelPassword", label: "管理员密码", type: "password", secret: true },
    { key: "protocol", label: "节点协议", type: "select", options: [{ label: "VLESS", value: "VLESS" }, { label: "VMess", value: "VMess" }, { label: "Trojan", value: "Trojan" }, { label: "Shadowsocks", value: "Shadowsocks" }] },
    { key: "socksRawInput", label: "SOCKS 出站", type: "textarea" },
  ],
  steps: { install: adapterSteps("install"), "create-node": adapterSteps("create-node"), "get-tls": [{ key: "verify", title: "读取 3x-ui TLS 证书路径" }] },
};

function asInboundInput(payload: Record<string, any>): InboundInput {
  const panelFlavor = ["mogai", "official", "compatible"].includes(payload.panelFlavor) ? payload.panelFlavor : "compatible";
  return { ...payload, panelFlavor } as InboundInput;
}

function xuiOptions(payload: Record<string, any>, signal: AbortSignal): XuiClientOptions {
  return {
    panelAddress: payload.panelAddress,
    panelPort: payload.panelPort,
    panelPath: payload.panelPath,
    panelProtocol: payload.panelProtocol === "https" ? "https" : "http",
    panelUser: payload.panelUser,
    panelPass: payload.panelPass,
    panelToken: payload.panelToken,
    panelFlavor: ["mogai", "official", "compatible"].includes(payload.panelFlavor) ? payload.panelFlavor : "compatible",
    allowInsecureTls: payload.allowInsecureTls === true,
    signal,
  };
}

class ThreeXUiAdapter implements PanelAdapter {
  metadata = threeXUiMetadata;
  constructor(private readonly dependencies: ThreeXUiAdapterDependencies = {}) {}

  async execute(operation: PanelAdapterOperation, context: PanelAdapterContext): Promise<unknown> {
    if (operation === "install") return this.install(context);
    if (operation === "create-node") return this.createNode(context);
    if (operation === "get-tls") return this.getTls(context);
    throw new Error(`3x-ui 不支持任务操作：${operation}`);
  }

  private async getTls(context: PanelAdapterContext) {
    return context.step("verify", async () => {
      const client = (this.dependencies.client || ((options: XuiClientOptions) => new XuiClient(options)))(xuiOptions(context.payload, context.signal));
      try {
        const files = await client.getWebCertFiles();
        return { adapterId: this.metadata.id, files, sni: cleanHostInput(context.payload.panelAddress) };
      } finally {
        await client.close().catch(() => undefined);
      }
    });
  }

  private async install(context: PanelAdapterContext) {
    const body = context.payload as Record<string, any> & SshInput;
    const connect = this.dependencies.connect || connectSsh;
    const inspect = this.dependencies.inspect || inspectServer;
    const exec = this.dependencies.exec || execSsh;
    const makeClient = this.dependencies.client || ((options: XuiClientOptions) => new XuiClient(options));
    const wait = this.dependencies.sleep || sleep;
    const host = cleanHostInput(body.ipOrDomain);
    if (!host) throw new Error("请输入有效的服务器 IP 或域名");
    const panelPort = body.panelPort || body.servicePort ? validPort(body.panelPort || body.servicePort) : 20_000 + Math.floor(Math.random() * 30_000);
    const panelPath = normalizeWebPath(body.panelPath || `/xui_${randomToken(3)}`);
    const domain = cleanHostInput(body.domain);
    const scriptType = ["recommended", "official", "custom"].includes(body.scriptType) ? body.scriptType : "recommended";
    const sslMode: "none" | "domain" | "ip" = scriptType === "recommended" || body.autoSSL ? (domain ? "domain" : "ip") : "none";
    const scriptUrl = scriptType === "official" ? OFFICIAL_INSTALLER : scriptType === "custom" ? String(body.customScriptUrl || "") : RECOMMENDED_INSTALLER;
    if (scriptType === "custom" && !/^https:\/\//i.test(scriptUrl)) throw new Error("自定义脚本地址必须使用 HTTPS");
    const username = panelUsername(body.panelUsername, `admin_${randomToken(3)}`);
    const password = panelPassword(body.panelPassword, `Xui_${randomBytes(12).toString("base64url")}`);
    const ownsSession = !body.sshSession;
    let session: Awaited<ReturnType<typeof connectSsh>> | undefined;
    let client: XuiClient | undefined;
    try {
      const systemInfo = await context.step("preflight", async () => {
        context.log(`[SSH] 正在连接 ${host}:${body.sshPort || 22}`);
        session = body.sshSession || await connect(body, { timeoutMs: 25_000 });
        const info = await inspect(session);
        if (info.status === "incompatible") throw new Error("服务器没有可用的 systemd，无法安装 3x-ui 服务");
        if (!info.isRoot) {
          const sudo = await exec(session.client, "sudo -n true", { timeoutMs: 10_000 });
          if (sudo.code !== 0) throw new Error("当前 SSH 用户不是 root，且没有免密 sudo 权限");
        }
        context.progress(20, `[OS] ${info.osName} / ${info.arch}`);
        return info;
      });
      const install = await context.step("install", async () => {
        if (!session) throw new Error("SSH 会话未建立");
        const command = buildInstallCommand({
          scriptUrl, username, password, panelPort, webBasePath: panelPath, serverIp: host, sslMode,
          domain: domain || undefined, useSudo: !systemInfo.isRoot,
          interactiveAnswers: scriptType === "recommended" ? sslMode === "domain" ? ["y", String(panelPort), "1", domain, "", "n", "y"] : ["y", String(panelPort), "2", "", ""] : undefined,
          configurePanelAfterInstall: true,
        });
        context.log("[INSTALL] 正在执行适配器安装脚本");
        const result = await exec(session.client, command, { timeoutMs: 20 * 60_000 });
        if (result.code !== 0) throw new Error(`3x-ui 安装脚本退出码 ${result.code}`);
        return result;
      });
      const verified = await context.step("verify", async () => {
        if (!session) throw new Error("SSH 会话未建立");
        const sudo = systemInfo.isRoot ? "" : "sudo -n ";
        const verifyCommand = `${sudo}systemctl is-active x-ui && ${sudo}bash -c 'if [ -r /etc/x-ui/install-result.env ]; then . /etc/x-ui/install-result.env; printf "__XUI_USERNAME__=%s\\n__XUI_PASSWORD__=%s\\n__XUI_PANEL_PORT__=%s\\n__XUI_WEB_BASE_PATH__=%s\\n__XUI_ACCESS_URL__=%s\\n__XUI_API_TOKEN__=%s\\n" "$XUI_USERNAME" "$XUI_PASSWORD" "$XUI_PANEL_PORT" "$XUI_WEB_BASE_PATH" "$XUI_ACCESS_URL" "$XUI_API_TOKEN"; fi'`;
        const verify = await exec(session.client, verifyCommand, { timeoutMs: 30_000 });
        if (verify.code !== 0 || !verify.stdout.startsWith("active")) throw new Error(verify.stderr || "x-ui 服务没有成功启动");
        const installed = parseInstallerResult(verify.stdout);
        const protocol = installed.ACCESS_URL?.startsWith("https://") || (sslMode !== "none" && Boolean(domain)) ? "https" : "http";
        const accessUrl = installed.ACCESS_URL || `${protocol}://${domain || host}:${installed.PANEL_PORT || panelPort}${installed.WEB_BASE_PATH || panelPath}`;
        client = makeClient({ panelAddress: domain || host, panelPort: installed.PANEL_PORT || panelPort, panelPath: installed.WEB_BASE_PATH || panelPath, panelProtocol: accessUrl.startsWith("https://") ? "https" : "http", panelUser: username, panelPass: password, allowInsecureTls: true });
        let authError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try { await client.authenticate(); authError = undefined; break; } catch (error) { authError = error; if (attempt < 3) await wait(attempt * 50); }
        }
        if (authError) throw new Error(`面板服务已启动，但安装后登录凭证验证失败：${message(authError)}`);
        const apiToken = installed.API_TOKEN || parseApiTokenFromOutput(`${install.stdout}\n${install.stderr}`) || await client.getApiToken();
        context.progress(85, "3x-ui 登录和 API Token 验证通过");
        return { installed, accessUrl, apiToken, systemInfo, protocol };
      });
      return await context.step("result", async () => ({
        adapterId: this.metadata.id,
        id: `panel-${randomUUID()}`,
        createdAt: new Date().toISOString(),
        accessUrl: verified.accessUrl,
        protocol: verified.protocol,
        host: domain || host,
        port: String(verified.installed.PANEL_PORT || panelPort),
        path: verified.installed.WEB_BASE_PATH || panelPath,
        username,
        password,
        apiToken: verified.apiToken,
        webCertFile: verified.installed.WEB_CERT_FILE || undefined,
        webKeyFile: verified.installed.WEB_KEY_FILE || undefined,
        sslEnabled: verified.accessUrl.startsWith("https://"),
        scriptType,
        panelFlavor: scriptType === "recommended" ? "mogai" : scriptType === "official" ? "official" : "compatible",
        systemInfo: verified.systemInfo,
      }));
    } finally {
      if (ownsSession) session?.client.end?.();
      await client?.close().catch(() => undefined);
    }
  }

  private async createNode(context: PanelAdapterContext) {
    const body = context.payload;
    const panelToken = optionalString(body.panelToken);
    if (!panelToken) throw new Error("缺少 3x-ui API Token，请从面板搭建结果进入节点页面或手动填写 Token");
    const makeClient = this.dependencies.client || ((options: XuiClientOptions) => new XuiClient(options));
    const client = makeClient(xuiOptions(body, context.signal));
    let built: ReturnType<typeof buildInbound> | undefined;
    let createdId = 0;
    let createdTag = "";
    let templateBefore: { config: unknown; outboundTestUrl: string } | undefined;
    let templateChanged = false;
    try {
      return await context.step("preflight", async () => {
        context.checkCancelled();
        let reality: { privateKey: string; publicKey: string } | undefined;
        if (body.security === "Reality") reality = await client.getRealityKeyPair();
        const tlsFiles = body.security === "TLS" ? { webCertFile: optionalString(body.tlsCertFile), webKeyFile: optionalString(body.tlsKeyFile) } : undefined;
        if (tlsFiles && (!tlsFiles.webCertFile || !tlsFiles.webKeyFile)) throw new Error("缺少面板安装阶段读取的 TLS 证书路径");
        built = buildInbound(tlsFiles ? { ...asInboundInput(body), sni: optionalString(body.sni) || cleanHostInput(body.panelAddress), tlsCertFile: tlsFiles.webCertFile, tlsKeyFile: tlsFiles.webKeyFile } : asInboundInput(body), reality);
        return { reality };
      }).then(async ({ reality }) => {
        const created = await context.step("create", async () => {
          if (!built) throw new Error("节点参数未生成");
          const result = await client.addInbound(built.payload, body.protocol || "VLESS", 30_000);
          createdId = Number(result?.id || 0);
          createdTag = optionalString(result?.tag) || built.tag;
          if (!createdId) {
            const matched = findInboundRecord(await client.listInbounds(), { tag: built.tag, protocol: body.protocol || "VLESS", port: built.port });
            createdId = Number(matched?.id || 0); createdTag = optionalString(matched?.tag) || createdTag;
          }
          if (!createdId) throw new Error("3x-ui 已返回创建成功，但无法确认新入站 ID");
          context.progress(50, "3x-ui 入站已创建并完成确认");
          return { reality };
        });
        const routed = await context.step("route", async () => {
          if (!built) throw new Error("节点参数未生成");
          const parsed = parseSocksInput(body.socksRawInput);
          if (!(body.autoOutbound && parsed.length)) return { proxies: parsed, outbounds: [], rules: [], explanation: "未配置 SOCKS 出站，入站流量使用面板默认路由。" };
          if (!optionalString(body.panelUser) || !optionalString(body.panelPass)) throw new Error("SOCKS 链式路由需要面板用户名和密码");
          const current = await client.getXrayTemplate();
          templateBefore = { config: current.xraySetting, outboundTestUrl: current.outboundTestUrl || "" };
          const injected = injectSocksRouting(current.xraySetting, parsed, createdTag || built.tag, body.autoRouting !== false, body.enableLoadBalance === true);
          templateChanged = true;
          await client.updateXrayTemplate(injected.config, current.outboundTestUrl || "");
          await client.restartXray();
          if (!findInboundRecord(await client.listInbounds(), { tag: createdTag || built.tag, protocol: body.protocol || "VLESS", port: built.port })) throw new Error("Xray 重载后无法确认新入站");
          return { proxies: injected.proxies, outbounds: injected.outbounds, rules: injected.rules, explanation: injected.balancer ? `已写入并重载 ${injected.proxies.length} 个 SOCKS 出站，并绑定随机负载均衡器。` : `已写入并重载 ${injected.proxies.length} 个 SOCKS 出站，并绑定该入站路由。` };
        });
        return context.step("result", async () => {
          if (!built) throw new Error("节点参数未生成");
          const address = cleanHostInput(body.panelAddress);
          const realitySettings = built.payload.streamSettings.realitySettings;
          return {
            adapterId: this.metadata.id,
            id: `node-${randomUUID()}`,
            inboundId: createdId,
            inboundTag: createdTag || built.tag,
            createdAt: new Date().toISOString(),
            nodeName: optionalString(body.nodeName) || `node-${built.port}`,
            protocol: body.protocol || "VLESS", transport: body.transport || "TCP", security: body.security || "Reality",
            shareLink: built.shareLink(address, reality?.publicKey), inboundPort: built.port, uuid: built.credential,
            socksConfigured: routed.proxies.length > 0 && Boolean(body.autoOutbound), socksList: routed.proxies,
            xrayOutboundsJson: JSON.stringify(routed.outbounds, null, 2), xrayRoutingJson: JSON.stringify(routed.rules, null, 2),
            socksExplanation: routed.explanation,
            realityParamsUsed: reality ? { sni: realitySettings.serverNames[0], publicKey: reality.publicKey, shortId: realitySettings.shortIds[0], autoGenerated: !optionalString(body.sni) } : null,
          };
        });
      });
    } catch (error) {
      if (templateChanged && templateBefore) await client.updateXrayTemplate(templateBefore.config, templateBefore.outboundTestUrl).catch(() => undefined);
      if (createdId) await client.deleteInbound(createdId).catch(() => undefined);
      throw error;
    } finally {
      await client.close().catch(() => undefined);
    }
  }
}

export function createThreeXUiAdapter(dependencies?: ThreeXUiAdapterDependencies): PanelAdapter {
  return new ThreeXUiAdapter(dependencies);
}

const registry = new Map<string, PanelAdapter>([[threeXUiMetadata.id, createThreeXUiAdapter()]]);

export function registerPanelAdapter(adapter: PanelAdapter) {
  if (!adapter.metadata?.id || !/^[a-z0-9][a-z0-9.-]{1,63}$/i.test(adapter.metadata.id)) throw new Error("适配器 ID 无效");
  registry.set(adapter.metadata.id, adapter);
  return adapter;
}

export function getPanelAdapter(id: unknown): PanelAdapter | undefined {
  return registry.get(String(id || ""));
}

export function listPanelAdapters(): PanelAdapterMetadata[] {
  return [...registry.values()].map(adapter => adapter.metadata);
}

export function getPanelAdapterSteps(id: unknown, operation: PanelAdapterOperation) {
  const adapter = getPanelAdapter(id);
  if (!adapter) throw new Error(`未知面板适配器：${String(id || "")}`);
  if (!adapter.metadata.operations.includes(operation)) throw new Error(`适配器 ${adapter.metadata.name} 不支持 ${operation} 操作`);
  return adapter.metadata.steps[operation];
}
