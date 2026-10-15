import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer as createViteServer } from "vite";
import { buildInbound, InboundInput } from "./server/inbound-builder.js";
import { buildInstallCommand, connectSsh, execSsh, formatServerInspectionError, inspectServer, SshInput } from "./server/ssh.js";
import { assertHttpsUrl, cleanHostInput, normalizeWebPath, optionalString, panelPassword, panelUsername, randomToken, validPort } from "./server/validation.js";
import { findInboundRecord, isRetryablePanelConnectionError, parseApiTokenFromOutput, XuiClient, XuiClientOptions } from "./server/xui-client.js";
import { injectSocksRouting, parseSocksInput } from "./server/xray-template.js";
import { mountPanelArkApi } from "./server/panelark-api.js";
import { isAdminPagePath, markAdminHtml, readAdminPath } from "./server/admin-path.js";

type ServerInspection = Awaited<ReturnType<typeof inspectServer>>;
type CachedSshInspection = {
  details: ServerInspection;
  host: string;
  port: number;
  user: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
};

const cachedSshInspections = new Map<string, CachedSshInspection>();
const SSH_SESSION_TTL_MS = 5 * 60_000;

function cacheSshInspection(
  session: Awaited<ReturnType<typeof connectSsh>>,
  details: ServerInspection,
): string {
  const id = randomUUID();
  const timer = setTimeout(() => {
    const cached = cachedSshInspections.get(id);
    if (!cached) return;
    cachedSshInspections.delete(id);
  }, SSH_SESSION_TTL_MS);
  timer.unref();
  cachedSshInspections.set(id, {
    details,
    host: session.host,
    port: session.port,
    user: session.user,
    expiresAt: Date.now() + SSH_SESSION_TTL_MS,
    timer,
  });
  return id;
}

function removeSshInspection(id: unknown) {
  const sessionId = optionalString(id);
  if (!sessionId) return;
  const cached = cachedSshInspections.get(sessionId);
  if (!cached) return;
  cachedSshInspections.delete(sessionId);
  clearTimeout(cached.timer);
}

function takeSshInspection(id: unknown, input: SshInput): ServerInspection | undefined {
  const sessionId = optionalString(id);
  if (!sessionId) return undefined;
  const cached = cachedSshInspections.get(sessionId);
  if (!cached) return undefined;
  cachedSshInspections.delete(sessionId);
  clearTimeout(cached.timer);

  const sameTarget = cached.expiresAt > Date.now()
    && cached.host === cleanHostInput(input.ipOrDomain)
    && cached.port === validPort(input.sshPort, 22)
    && cached.user === optionalString(input.sshUser || "root");
  return sameTarget ? cached.details : undefined;
}

const RECOMMENDED_INSTALLER = "https://raw.githubusercontent.com/wstimin/mogai-3xui/main/install.sh";
const OFFICIAL_INSTALLER = "https://raw.githubusercontent.com/MHSanaei/3x-ui/master/install.sh";

function noStore(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  next();
}

function runtimeVersion() {
  const configured = optionalString(process.env.APP_VERSION);
  if (configured) return configured;
  const versionFile = path.join(process.cwd(), "VERSION");
  if (fs.existsSync(versionFile)) return fs.readFileSync(versionFile, "utf8").trim();
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
    return optionalString(manifest.version) || "development";
  } catch { return "development"; }
}

function requireAppAuth(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.APP_AUTH_TOKEN;
  if (!expected) return next();
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  const supplied = bearer || req.header("x-app-token");
  if (supplied !== expected) return res.status(401).json({ error: "部署助手认证失败" });
  next();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function sendError(res: Response, error: unknown, status = 400) {
  if (!res.headersSent) res.status(status).json({ success: false, error: errorMessage(error) });
}

function xuiOptions(body: Record<string, any>, signal?: AbortSignal): XuiClientOptions {
  return {
    panelAddress: body.panelAddress,
    panelPort: body.panelPort,
    panelPath: body.panelPath,
    panelProtocol: body.panelProtocol === "https" ? "https" : "http",
    panelUser: body.panelUser,
    panelPass: body.panelPass,
    panelToken: body.panelToken,
    panelFlavor: body.panelFlavor,
    allowInsecureTls: body.allowInsecureTls === true,
    signal,
  };
}

function parseInstallerResult(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^__XUI_([A-Z_]+)__=(.*)$/);
    if (match) {
      const value = match[2].trim();
      if (value || !(match[1] in values)) values[match[1]] = value;
    }
  }
  return values;
}

async function startServer() {
  const app = express();
  const port = validPort(process.env.PORT, 1888);
  const production = process.env.NODE_ENV === "production";
  const httpsConfigured = Boolean(optionalString(process.env.SSL_CERT) && optionalString(process.env.SSL_KEY));

  app.disable("x-powered-by");
  app.set("trust proxy", process.env.PANELARK_TRUST_PROXY === "true" ? 1 : "loopback");
  app.use(helmet({
    contentSecurityPolicy: production ? {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        upgradeInsecureRequests: httpsConfigured ? [] : null,
      },
    } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
    strictTransportSecurity: production && httpsConfigured ? { maxAge: 31_536_000, includeSubDomains: true, preload: false } : false,
  }));
  app.use((req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    res.setHeader("X-Request-Id", req.header("x-request-id")?.slice(0, 80) || randomUUID());
    if (production && process.env.PANELARK_REQUIRE_HTTPS === "true" && !(req.secure || req.header("x-forwarded-proto") === "https")) {
      return res.status(426).json({ success: false, error: "生产环境要求通过 HTTPS 访问" });
    }
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
  app.use("/api", noStore);

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      version: runtimeVersion(),
      timestamp: new Date().toISOString(),
    });
  });

  const panelArk = await mountPanelArkApi(app);

  app.use("/api", requireAppAuth);

  app.get("/api/download-zip", (_req, res) => {
    res.status(404).json({ error: "源码导出接口已禁用，避免意外打包凭据、证书或数据库。" });
  });

  app.post("/api/test-ssh", async (req, res) => {
    let session;
    let completed = false;
    const handleDisconnect = () => {
      if (!completed && !res.writableEnded) session?.client.destroy();
    };
    res.on("close", handleDisconnect);
    try {
      const input = req.body as SshInput;
      removeSshInspection(req.body?.sshSessionId);
      session = await connectSsh(input, { timeoutMs: 18_000 });
      let details: ServerInspection;
      try {
        details = await inspectServer(session, { timeoutMs: 10_000 });
      } catch (error) {
        throw new Error(formatServerInspectionError(error));
      }
      const sshSessionId = cacheSshInspection(session, details);
      completed = true;
      res.json({ success: true, message: "SSH 连接及必要环境检测成功", details, sshSessionId });
    } catch (error) {
      completed = true;
      sendError(res, error);
    } finally {
      res.off("close", handleDisconnect);
      session?.client.end();
    }
  });

  app.post("/api/deploy-panel", async (req, res) => {
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const write = (event: Record<string, unknown>) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`${JSON.stringify(event)}\n`);
      (res as Response & { flush?: () => void }).flush?.();
    };
    const heartbeat = setInterval(() => write({ type: "heartbeat", timestamp: Date.now() }), 10_000);
    heartbeat.unref();
    let session;
    let panelClient: XuiClient | undefined;
    let completed = false;
    const handleDisconnect = () => {
      if (!completed && !res.writableEnded) session?.client.destroy();
    };
    res.on("close", handleDisconnect);

    try {
      const body = req.body as Record<string, any> & SshInput;
      const host = cleanHostInput(body.ipOrDomain);
      if (!host) throw new Error("请输入有效的服务器 IP 或域名");
      const panelPort = body.panelPort ? validPort(body.panelPort) : 20_000 + Math.floor(Math.random() * 30_000);
      const panelPath = normalizeWebPath(body.panelPath || `/xui_${randomToken(3)}`);
      const domain = cleanHostInput(body.domain);
      const scriptType = ["recommended", "official", "custom"].includes(body.scriptType)
        ? body.scriptType
        : "recommended";
      const sslMode: "none" | "domain" | "ip" = scriptType === "recommended" || body.autoSSL
        ? (domain ? "domain" : "ip")
        : "none";
      let scriptUrl = scriptType === "official" ? OFFICIAL_INSTALLER : RECOMMENDED_INSTALLER;
      if (scriptType === "custom") scriptUrl = assertHttpsUrl(optionalString(body.customScriptUrl), "自定义脚本地址");
      const username = panelUsername(body.panelUsername, `admin_${randomToken(3)}`);
      const password = panelPassword(body.panelPassword, `Xui_${randomBytes(12).toString("base64url")}`);

      const cachedInspection = takeSshInspection(body.sshSessionId, body);
      let systemInfo: ServerInspection;
      write({ type: "log", step: 1, message: `[SSH] 正在建立正式部署连接 ${host}:${body.sshPort || 22}` });
      session = await connectSsh(body, { timeoutMs: 25_000 });
      write({ type: "log", step: 1, message: `[SSH] 正式部署连接成功，主机密钥指纹 ${session.fingerprint}` });
      if (cachedInspection) {
        systemInfo = cachedInspection;
        write({ type: "log", step: 2, message: `[OS] 已复用快速检测结果：${systemInfo.osName} / ${systemInfo.arch}` });
      } else {
        systemInfo = await inspectServer(session);
        write({ type: "log", step: 2, message: `[OS] ${systemInfo.osName} / ${systemInfo.arch}` });
      }
      if (systemInfo.status === "incompatible") throw new Error("服务器没有可用的 systemd，无法安装 3x-ui 服务");
      if (!systemInfo.isRoot) {
        const sudo = await execSsh(session.client, "sudo -n true", { timeoutMs: 10_000 });
        if (sudo.code !== 0) throw new Error("当前 SSH 用户不是 root，且没有免密 sudo 权限");
      }

      const scriptLabel = scriptType === "recommended" ? "推荐兼容脚本" : scriptType === "official" ? "官方脚本" : "自定义脚本";
      write({ type: "log", step: 3, message: `[ENV] 环境检查完成，准备执行${scriptLabel}` });
      const command = buildInstallCommand({
        scriptUrl,
        username,
        password,
        panelPort,
        webBasePath: panelPath,
        serverIp: host,
        sslMode,
        domain: domain || undefined,
        useSudo: !systemInfo.isRoot,
        interactiveAnswers: scriptType === "recommended"
          ? sslMode === "domain"
            ? ["y", String(panelPort), "1", domain, "", "n", "y"]
            : ["y", String(panelPort), "2", "", ""]
          : undefined,
        configurePanelAfterInstall: true,
      });
      write({ type: "log", step: 4, message: `[INSTALL] 正在执行${scriptLabel}，安装输出已在后端安全收集` });
      const installProgressTimers = [
        setTimeout(() => write({ type: "log", step: 5, message: "[INSTALL] 正在安装组件并写入面板配置" }), 12_000),
        setTimeout(() => write({ type: "log", step: 6, message: "[CONFIG] 正在初始化面板服务与访问参数" }), 35_000),
      ];
      let install;
      try {
        install = await execSsh(session.client, command, {
          timeoutMs: 20 * 60_000,
        });
      } finally {
        installProgressTimers.forEach(clearTimeout);
      }
      if (install.code !== 0) {
        const lastError = install.stderr
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line && !/curl|bash\s|https?:\/\/|token|password|username/i.test(line))
          .at(-1);
        throw new Error(lastError ? `3x-ui 安装失败：${lastError.slice(0, 240)}` : `3x-ui 安装脚本退出码 ${install.code}`);
      }

      write({ type: "log", step: 7, message: "[VERIFY] 正在验证服务和读取安装结果" });
      const sudo = systemInfo.isRoot ? "" : "sudo -n ";
      const verifyCommand = `${sudo}systemctl is-active x-ui && ${sudo}bash -c 'if [ -r /etc/x-ui/install-result.env ]; then . /etc/x-ui/install-result.env; printf "__XUI_USERNAME__=%s\\n__XUI_PASSWORD__=%s\\n__XUI_PANEL_PORT__=%s\\n__XUI_WEB_BASE_PATH__=%s\\n__XUI_ACCESS_URL__=%s\\n__XUI_API_TOKEN__=%s\\n" "$XUI_USERNAME" "$XUI_PASSWORD" "$XUI_PANEL_PORT" "$XUI_WEB_BASE_PATH" "$XUI_ACCESS_URL" "$XUI_API_TOKEN"; fi; if [ -x /usr/local/x-ui/x-ui ]; then cert_output=$(/usr/local/x-ui/x-ui setting -getCert true 2>/dev/null || true); web_cert=$(printf "%s\\n" "$cert_output" | awk -F": *" "/^[[:space:]]*cert:/{print \\$2; exit}"); web_key=$(printf "%s\\n" "$cert_output" | awk -F": *" "/^[[:space:]]*key:/{print \\$2; exit}"); printf "__XUI_WEB_CERT_FILE__=%s\\n__XUI_WEB_KEY_FILE__=%s\\n" "$web_cert" "$web_key"; fi'`;
      const verify = await execSsh(session.client, verifyCommand, { timeoutMs: 30_000 });
      if (verify.code !== 0 || !verify.stdout.startsWith("active")) throw new Error(verify.stderr || "x-ui 服务没有成功启动");
      const installed = parseInstallerResult(verify.stdout);
      const installedPort = String(panelPort);
      const installedPath = panelPath;
      const recommendedTlsReady = Boolean(installed.WEB_CERT_FILE && installed.WEB_KEY_FILE);
      const fallbackProtocol = scriptType === "recommended"
        ? recommendedTlsReady ? "https" : "http"
        : sslMode === "none" ? "http" : "https";
      const accessUrl = `${fallbackProtocol}://${domain || host}:${installedPort}${installedPath}`;

      write({ type: "log", step: 8, message: "[AUTH] 正在验证面板登录凭证" });
      panelClient = new XuiClient({
        panelAddress: domain || host,
        panelPort: installedPort,
        panelPath: installedPath,
        panelProtocol: accessUrl.startsWith("https://") ? "https" : "http",
        panelUser: username,
        panelPass: password,
        allowInsecureTls: true,
      });
      let panelAuthError: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await panelClient.authenticate();
          panelAuthError = undefined;
          break;
        } catch (error) {
          panelAuthError = error;
          if (/面板拒绝了当前用户名或密码|用户名或密码错误/i.test(errorMessage(error))) break;
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
        }
      }
      if (panelAuthError) {
        throw new Error(`面板服务已启动，但安装后登录凭证验证失败：${errorMessage(panelAuthError)}`);
      }

      let apiToken = installed.API_TOKEN || parseApiTokenFromOutput(`${install.stdout}\n${install.stderr}`) || undefined;
      if (apiToken) {
        write({ type: "log", step: 8, message: "[TOKEN] 登录凭证已验证，并已从安装结果中提取面板 API Token" });
      }
      if (!apiToken) {
        write({ type: "log", step: 8, message: "[TOKEN] 正在读取节点创建所需的 API Token" });
        try {
          apiToken = await panelClient.getApiToken();
        } catch (error) {
          throw new Error(`面板已安装，但未能读取创建节点所需的 API Token：${errorMessage(error)}`);
        }
        write({ type: "log", step: 8, message: "[TOKEN] API Token 已读取并将自动带入节点页面" });
      }

      const result = {
        id: `panel-${Date.now()}`,
        createdAt: new Date().toLocaleString("zh-CN"),
        accessUrl,
        protocol: accessUrl.startsWith("https://") ? "https" : "http",
        host: domain || host,
        port: installedPort,
        path: installedPath,
        username,
        password,
        apiToken,
        webCertFile: installed.WEB_CERT_FILE || undefined,
        webKeyFile: installed.WEB_KEY_FILE || undefined,
        sslEnabled: accessUrl.startsWith("https://"),
        scriptType,
        panelFlavor: scriptType === "recommended"
          ? "mogai"
          : scriptType === "official"
            ? "official"
            : "compatible",
        systemInfo,
      };
      write({ type: "log", step: 9, message: "[SUCCESS] 3x-ui 服务已启动，安装结果验证通过" });
      write({ type: "result", result });
      completed = true;
    } catch (error) {
      write({ type: "error", error: errorMessage(error) });
      completed = true;
    } finally {
      clearInterval(heartbeat);
      res.off("close", handleDisconnect);
      session?.client.end();
      await panelClient?.close().catch(() => undefined);
      res.end();
    }
  });

  app.post("/api/get-panel-tls", async (req, res) => {
    let client: XuiClient | undefined;
    try {
      client = new XuiClient(xuiOptions(req.body));
      const files = await client.getWebCertFiles();
      res.json({ success: true, files, sni: cleanHostInput(req.body.panelAddress) });
    } catch (error) {
      sendError(res, error);
    } finally {
      await client?.close().catch(() => undefined);
    }
  });

  app.post("/api/deploy-node", async (req, res) => {
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    const write = (event: Record<string, unknown>) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`${JSON.stringify(event)}\n`);
      (res as Response & { flush?: () => void }).flush?.();
    };
    const progress = (step: number, message: string) => write({ type: "progress", step, total: 5, message });
    const heartbeat = setInterval(() => write({ type: "heartbeat", timestamp: Date.now() }), 10_000);
    heartbeat.unref();
    const cancellation = new AbortController();
    const handleDisconnect = () => {
      if (!res.writableEnded) cancellation.abort();
    };
    res.on("close", handleDisconnect);

    const body = req.body as Record<string, any> & InboundInput;
    const panelClients = new Set<XuiClient>();
    const createPanelClient = (signal?: AbortSignal) => {
      const next = new XuiClient(xuiOptions(body, signal));
      panelClients.add(next);
      return next;
    };
    let client: XuiClient | undefined;
    let built: ReturnType<typeof buildInbound> | undefined;
    let inboundId = 0;
    let inboundTag = "";
    let originalXrayTemplate: { config: unknown; outboundTestUrl: string } | undefined;
    let xrayTemplateUpdated = false;
    let xrayRestartAttempted = false;
    let creationOutcomeUncertain = false;
    try {
      const panelToken = optionalString(body.panelToken);
      if (!panelToken) throw new Error("缺少 3x-ui API Token，请从面板搭建结果进入节点页面或手动填写 Token");

      const panelFlavor = ["mogai", "official", "compatible"].includes(body.panelFlavor)
        ? body.panelFlavor
        : "compatible";

      client = createPanelClient(cancellation.signal);
      let reality: { privateKey: string; publicKey: string } | undefined;
      if (body.security === "Reality") {
        progress(1, "正在向 3x-ui 获取 Reality 密钥");
        const realityStartedAt = Date.now();
        try {
          reality = await client.getRealityKeyPair();
        } catch (error) {
          if (cancellation.signal.aborted || !isRetryablePanelConnectionError(error)) throw error;
          progress(1, "Reality 密钥请求连接异常，正在使用新连接重试");
          await client.close().catch(() => undefined);
          client = createPanelClient(cancellation.signal);
          reality = await client.getRealityKeyPair();
        }
        progress(1, `Reality 密钥已获取（${formatElapsed(Date.now() - realityStartedAt)}）`);
      } else {
        progress(1, "正在生成节点安全参数");
      }
      const tlsFiles = body.security === "TLS" ? {
        webCertFile: optionalString(body.tlsCertFile),
        webKeyFile: optionalString(body.tlsKeyFile),
      } : undefined;
      if (tlsFiles && (!tlsFiles.webCertFile || !tlsFiles.webKeyFile)) {
        throw new Error("缺少面板安装阶段读取的 TLS 证书路径，请重新搭建面板或先读取面板证书");
      }
      const inboundInput = tlsFiles ? {
        ...body,
        panelFlavor,
        sni: optionalString(body.sni) || cleanHostInput(body.panelAddress),
        tlsCertFile: tlsFiles.webCertFile,
        tlsKeyFile: tlsFiles.webKeyFile,
      } : { ...body, panelFlavor };
      built = buildInbound(inboundInput, reality);
      if (cancellation.signal.aborted) throw new Error("节点创建已终止");

      progress(1, "节点参数已生成");
      progress(2, `正在调用 3x-ui 创建 ${body.protocol || "VLESS"} 入站`);
      const inboundStartedAt = Date.now();
      let created: any;
      try {
        created = await client.addInbound(built.payload, body.protocol || "VLESS", 30_000);
      } catch (error) {
        if (cancellation.signal.aborted || !isRetryablePanelConnectionError(error)) throw error;
        creationOutcomeUncertain = true;
        progress(2, "面板创建响应异常，正在通过新连接确认实际创建结果");
        await client.close().catch(() => undefined);
        client = createPanelClient(cancellation.signal);
        let confirmationError: unknown;
        for (let attempt = 1; attempt <= 6 && !created; attempt += 1) {
          if (attempt > 1) await new Promise(resolve => setTimeout(resolve, 2_000));
          try {
            const list = await client.listInbounds(10_000);
            const matched = findInboundRecord(list, {
              tag: built.tag,
              protocol: body.protocol || "VLESS",
              port: built.port,
            });
            if (matched) created = matched;
            confirmationError = undefined;
          } catch (confirmError) {
            confirmationError = confirmError;
            await client.close().catch(() => undefined);
            client = createPanelClient(cancellation.signal);
          }
        }
        if (!created) {
          const suffix = confirmationError ? `：${errorMessage(confirmationError)}` : "";
          throw new Error(`3x-ui 创建请求已超时，目前无法确认节点是否创建成功${suffix}。助手未重试创建、也未删除节点，请稍后在面板入站列表中确认`);
        }
        creationOutcomeUncertain = false;
        progress(2, "已从面板入站列表确认节点创建成功");
      }
      progress(2, `3x-ui 入站已创建（${formatElapsed(Date.now() - inboundStartedAt)}）`);
      inboundId = Number(created?.id || 0);
      inboundTag = optionalString(created?.tag) || built.tag;
      if (!inboundId) {
        const list = await client.listInbounds();
        const matched = findInboundRecord(list, {
          tag: built.tag,
          protocol: body.protocol || "VLESS",
          port: built.port,
        });
        inboundId = Number(matched?.id || 0);
        inboundTag = optionalString(matched?.tag) || inboundTag;
      }
      if (!inboundId) throw new Error("3x-ui 已返回创建成功，但无法确认新入站 ID");
      if (cancellation.signal.aborted) throw new Error("节点创建已终止");

      const parsedSocks = parseSocksInput(body.socksRawInput);
      let socksList = parsedSocks;
      let outbounds: any[] = [];
      let rules: any[] = [];
      let socksConfigured = false;
      let socksExplanation = "未配置 SOCKS 出站，入站流量使用面板默认路由。";
      if (body.autoOutbound && parsedSocks.length) {
        progress(3, `正在写入 ${parsedSocks.length} 个 SOCKS 出站与路由规则`);
        if (!optionalString(body.panelUser) || !optionalString(body.panelPass)) {
          throw new Error("SOCKS 链式路由需要面板用户名和密码");
        }
        const current = await client.getXrayTemplate();
        const config = current.xraySetting;
        originalXrayTemplate = { config, outboundTestUrl: current.outboundTestUrl || "" };
        const injected = injectSocksRouting(config, parsedSocks, inboundTag, body.autoRouting !== false, body.enableLoadBalance === true);
        xrayTemplateUpdated = true;
        await client.updateXrayTemplate(injected.config, current.outboundTestUrl || "");
        progress(3, "SOCKS 路由已保存，正在重载 Xray");
        xrayRestartAttempted = true;
        await client.restartXray();
        const confirmed = findInboundRecord(await client.listInbounds(), {
          tag: inboundTag,
          protocol: body.protocol || "VLESS",
          port: built.port,
        });
        if (!confirmed) throw new Error("Xray 重载后无法确认新入站，已撤销本次 SOCKS 节点创建");
        inboundId = Number(confirmed.id || inboundId);
        inboundTag = optionalString(confirmed.tag) || inboundTag;
        socksList = injected.proxies;
        outbounds = injected.outbounds;
        rules = injected.rules;
        socksConfigured = true;
        socksExplanation = injected.balancer
          ? `已写入并重载 ${socksList.length} 个 SOCKS 出站，并为该入站绑定随机负载均衡器。`
          : `已写入并重载 ${socksList.length} 个 SOCKS 出站，并绑定该入站路由。`;
      } else {
        progress(3, "无需配置额外路由");
      }
      if (cancellation.signal.aborted) throw new Error("节点创建已终止");

      progress(4, "正在生成节点链接");
      const address = cleanHostInput(body.panelAddress);
      const realitySettings = built.payload.streamSettings.realitySettings;
      const result = {
        id: `node-${Date.now()}`,
        inboundId,
        inboundTag,
        createdAt: new Date().toLocaleString("zh-CN"),
        nodeName: optionalString(body.nodeName) || `node-${built.port}`,
        protocol: body.protocol || "VLESS",
        transport: body.transport || "TCP",
        security: body.security || "Reality",
        shareLink: built.shareLink(address, reality?.publicKey),
        inboundPort: built.port,
        uuid: built.credential,
        socksConfigured,
        socksList,
        xrayOutboundsJson: JSON.stringify(outbounds, null, 2),
        xrayRoutingJson: JSON.stringify(rules, null, 2),
        socksExplanation,
        realityParamsUsed: reality ? {
          sni: realitySettings.serverNames[0],
          publicKey: reality.publicKey,
          shortId: realitySettings.shortIds[0],
          autoGenerated: !optionalString(body.sni),
        } : null,
      };
      progress(5, "节点创建完成");
      write({ type: "result", result });
    } catch (error) {
      let rollbackClient = client;
      if (cancellation.signal.aborted) {
        try {
          rollbackClient = createPanelClient();
        } catch {
          rollbackClient = undefined;
        }
      }
      if (rollbackClient && xrayTemplateUpdated && originalXrayTemplate) {
        try {
          await rollbackClient.updateXrayTemplate(originalXrayTemplate.config, originalXrayTemplate.outboundTestUrl);
        } catch {
          // Preserve the original failure and continue with inbound rollback.
        }
      }
      if (rollbackClient && !creationOutcomeUncertain && !inboundId && built) {
        try {
          const list = await rollbackClient.listInbounds();
          inboundId = Number(findInboundRecord(list, {
            tag: built.tag,
            protocol: body.protocol || "VLESS",
            port: built.port,
          })?.id || 0);
        } catch {
          // The add request may have been cancelled before the panel created anything.
        }
      }
      if (rollbackClient && !creationOutcomeUncertain && inboundId) {
        try {
          await rollbackClient.deleteInbound(inboundId);
        } catch {
          // Preserve the original failure; the progress response already explains the operation failed.
        }
      }
      if (rollbackClient && xrayRestartAttempted) {
        try {
          await rollbackClient.restartXray();
        } catch {
          // Preserve the original failure after making a best-effort runtime rollback.
        }
      }
      write({ type: "error", error: errorMessage(error), cancelled: cancellation.signal.aborted });
    } finally {
      clearInterval(heartbeat);
      res.off("close", handleDisconnect);
      await Promise.allSettled([...panelClients].map(panelClient => panelClient.close()));
      if (!res.writableEnded) res.end();
    }
  });

  app.post("/api/validate-socks", (req, res) => {
    const items = parseSocksInput(req.body?.rawInput);
    res.json({ success: true, count: items.length, items });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true, allowedHosts: true }, appType: "spa" });
    const sourceHtml = fs.readFileSync(path.join(process.cwd(), "index.html"), "utf8");
    app.use(async (req, res, next) => {
      if (req.method !== "GET" || !isAdminPagePath(req.path, readAdminPath(panelArk.db))) return next();
      try {
        const html = await vite.transformIndexHtml(req.originalUrl, markAdminHtml(sourceHtml, true));
        res.status(200).type("html").send(html);
      } catch (error) {
        vite.ssrFixStacktrace(error as Error);
        next(error);
      }
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    const indexHtml = fs.readFileSync(path.join(distPath, "index.html"), "utf8");
    app.use(express.static(distPath, { index: false }));
    app.get("*", (req, res) => {
      const admin = isAdminPagePath(req.path, readAdminPath(panelArk.db));
      res.status(200).type("html").send(markAdminHtml(indexHtml, admin));
    });
  }

  const certPath = process.env.SSL_CERT || "/etc/3xui-assistant/ssl/cert.pem";
  const keyPath = process.env.SSL_KEY || "/etc/3xui-assistant/ssl/key.pem";
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app);
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;
    server.listen(port, "0.0.0.0", () => console.log(`[HTTPS] PanelArk: https://0.0.0.0:${port}`));
  } else {
    const server = app.listen(port, "0.0.0.0", () => console.log(`[HTTP] PanelArk: http://0.0.0.0:${port}`));
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;
  }
}

startServer().catch((error) => {
  console.error("服务启动失败:", error);
  process.exitCode = 1;
});
