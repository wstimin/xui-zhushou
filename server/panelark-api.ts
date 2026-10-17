import fs from "node:fs";
import { pagedSql, pagination } from "./pagination.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express, { Express, NextFunction, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { PanelArkDatabase, DbRow } from "./panelark-db.js";
import { mountPanelArkRemoteApi } from "./panelark-remote.js";
import { attachJobSse, PanelArkJobEngine } from "./panelark-jobs.js";
import { getPanelAdapter, getPanelAdapterSteps, listPanelAdapters, PanelAdapterOperation } from "./panel-adapters.js";
import { registerCatalogAdapters } from "./catalog-adapters.js";
import { encryptCdkCode, mountCdkManagement } from "./cdk-management.js";
import { automaticFinalSteps, automaticSteps, executeAutomaticDeployment } from './automatic-deployment.js';
import { backupFilePath, backupLimits, backupPassphraseForRecord, backupPreview, createBackupArchive, decryptBackup, isBackupArchive, saveBackup, saveManagedBackup } from "./panelark-backup.js";
import { loadUpdatePublicKey, PanelArkUpdateManager, UpdateChannel } from "./panelark-update.js";
import { buildSecurityReport } from "./panelark-security-audit.js";
import { normalizeAdminPath, readAdminPath } from "./admin-path.js";
import { applicationUpdatePolicy, installationRequired, installationSettings, installationStatus, webInstallationEnabled } from "./setup.js";
import {
  generateCdkCode,
  generateTotpSecret,
  hashCdk,
  hashPassword,
  loadOrCreatePepper,
  normalizeCdk,
  normalizeUsername,
  parseCookies,
  randomSecret,
  safeEqualString,
  sha256,
  validatePassword,
  verifyTotp,
  verifyPassword,
} from "./panelark-security.js";

const SESSION_COOKIE = "panelark_admin_session";
const SESSION_HOURS = 8;
const GRANT_MINUTES = 30;
const ROLES = ["super_admin", "operator", "support"] as const;
type AdminRole = typeof ROLES[number];

type AdminContext = {
  id: string;
  username: string;
  role: AdminRole;
  sessionId: string;
  csrfToken: string;
};

type AuthenticatedRequest = Request & { panelarkAdmin?: AdminContext };

const PERMISSIONS: Record<AdminRole, Set<string>> = {
  super_admin: new Set(["*"]),
  operator: new Set(["dashboard:read", "cdk:read", "cdk:write", "cdk:export", "settings:read", "settings:write", "catalog:write", "resources:write", "jobs:read", "jobs:review", "audit:read"]),
  support: new Set(["dashboard:read", "cdk:read", "cdk:release", "settings:read", "jobs:read", "jobs:review", "audit:read"]),
};

function now() { return new Date().toISOString(); }
function future(minutes: number) { return new Date(Date.now() + minutes * 60_000).toISOString(); }
function text(value: unknown, max = 200) { return String(value || "").trim().slice(0, max); }
function bool(value: unknown) { return value === true || value === 1 || value === "1" || value === "true"; }
function jsonDetails(value: unknown) { return JSON.stringify(value || {}).slice(0, 4000); }
function sendError(res: Response, error: unknown, status = 400) {
  res.status(status).json({ success: false, error: error instanceof Error ? error.message : String(error) });
}

function setSessionCookie(req: Request, res: Response, token: string) {
  const secure = req.secure;
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api/admin; HttpOnly; SameSite=Strict; Priority=High; Max-Age=${SESSION_HOURS * 3600}${secure ? "; Secure" : ""}`);
}

function clearSessionCookie(req: Request, res: Response) {
  const secure = req.secure || req.header("x-forwarded-proto") === "https";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Priority=High; Max-Age=0${secure ? "; Secure" : ""}`);
}

function audit(db: PanelArkDatabase, req: Request, action: string, targetType?: string, targetId?: string, details?: unknown, adminId?: string) {
  db.run(
    "INSERT INTO audit_logs(admin_id, action, target_type, target_id, ip, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [adminId || null, action, targetType || null, targetId || null, req.ip || null, jsonDetails(details), now()],
  );
}

function cleanup(db: PanelArkDatabase) {
  const timestamp = now();
  db.transaction(() => {
    db.run("DELETE FROM admin_sessions WHERE expires_at <= ?", [timestamp]);
    db.run("UPDATE cdk_grants SET status = 'expired' WHERE status IN ('validated','locked') AND expires_at <= ?", [timestamp]);
  });
}

function hasPermission(admin: AdminContext, permission: string) {
  const permissions = PERMISSIONS[admin.role];
  return permissions.has("*") || permissions.has(permission);
}

function sessionMiddleware(db: PanelArkDatabase) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    cleanup(db);
    const token = parseCookies(req.header("cookie"))[SESSION_COOKIE];
    if (!token) return res.status(401).json({ success: false, error: "管理员会话已失效，请重新登录" });
    const row = db.get<DbRow>(
      `SELECT s.id AS session_id, s.csrf_token, a.id, a.username, a.role, a.enabled
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      [sha256(token), now()],
    );
    if (!row || Number(row.enabled) !== 1) return res.status(401).json({ success: false, error: "管理员会话已失效，请重新登录" });
    req.panelarkAdmin = {
      id: String(row.id), username: String(row.username), role: String(row.role) as AdminRole,
      sessionId: String(row.session_id), csrfToken: String(row.csrf_token),
    };
    db.run("UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?", [now(), req.panelarkAdmin.sessionId]);
    next();
  };
}

function requirePermission(permission: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.panelarkAdmin || !hasPermission(req.panelarkAdmin, permission)) {
      return res.status(403).json({ success: false, error: "当前管理员没有此操作权限" });
    }
    next();
  };
}

function requireCsrf(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const supplied = req.header("x-csrf-token") || "";
  if (!req.panelarkAdmin || !safeEqualString(supplied, req.panelarkAdmin.csrfToken)) {
    return res.status(403).json({ success: false, error: "安全令牌无效，请刷新后台后重试" });
  }
  next();
}

function createSession(db: PanelArkDatabase, req: Request, adminId: string) {
  const token = randomSecret();
  const csrfToken = randomSecret(24);
  const timestamp = now();
  db.run(
    "INSERT INTO admin_sessions(id, admin_id, token_hash, csrf_token, ip, user_agent, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [randomUUID(), adminId, sha256(token), csrfToken, req.ip || null, text(req.header("user-agent"), 500), timestamp, timestamp, future(SESSION_HOURS * 60)],
  );
  return { token, csrfToken };
}

function ensureSetupToken(db: PanelArkDatabase, dataDirectory: string) {
  if (db.get("SELECT id FROM admins LIMIT 1")) return;
  const configured = process.env.PANELARK_SETUP_TOKEN?.trim();
  const existing = db.get<DbRow>("SELECT value FROM site_settings WHERE key = 'admin_setup_token_hash'");
  if (configured) {
    db.run("INSERT OR REPLACE INTO site_settings(key, value, updated_at) VALUES ('admin_setup_token_hash', ?, ?)", [sha256(configured), now()]);
    return;
  }
  if (existing) return;
  const setupToken = `PAK-SETUP-${randomSecret(18)}`;
  db.run("INSERT INTO site_settings(key, value, updated_at) VALUES ('admin_setup_token_hash', ?, ?)", [sha256(setupToken), now()]);
  const tokenPath = path.join(dataDirectory, "admin-setup-token.txt");
  fs.writeFileSync(tokenPath, `${setupToken}\n`, { mode: 0o600 });
  console.log(`[PanelArk] 首次管理员初始化令牌已写入 ${tokenPath}`);
}

function seedCatalog(db: PanelArkDatabase) {
  if (!db.get("SELECT id FROM cdk_packages LIMIT 1")) {
    const timestamp = now();
    db.run(
      "INSERT INTO cdk_packages(id, name, description, max_uses, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)",
      ["pkg-single", "单次部署", "允许完成一次面板或工具部署", timestamp, timestamp],
    );
  }
}

function getPublicSettings(db: PanelArkDatabase) {
  const rows = db.all<DbRow>("SELECT key, value FROM site_settings WHERE key IN ('purchase_enabled','purchase_button_text','purchase_url','support_url','site_notice','site_name','site_url')");
  const values = Object.fromEntries(rows.map(row => [String(row.key), String(row.value)]));
  return {
    siteName: values.site_name || "PanelArk 面板方舟",
    siteUrl: values.site_url || "",
    purchaseEnabled: values.purchase_enabled !== "false",
    purchaseButtonText: values.purchase_button_text || "购买 CDK",
    purchaseUrl: values.purchase_url || "",
    supportUrl: values.support_url || "",
    siteNotice: values.site_notice || "",
  };
}

function getAdminSettings(db: PanelArkDatabase) {
  return { ...getPublicSettings(db), adminPath: readAdminPath(db) };
}

function catalogItems(db: PanelArkDatabase) {
  const overrides = new Map(db.all<DbRow>("SELECT * FROM catalog_overrides").map(row => [String(row.adapter_id), row]));
  return listPanelAdapters().map((item, index) => {
    const override = overrides.get(item.id);
    return {
      ...item,
      name: override?.name ? String(override.name) : item.name,
      description: override?.description ? String(override.description) : item.description,
      category: override?.category ? String(override.category) : item.category,
      enabled: override ? Number(override.enabled) === 1 : item.enabled,
      sortOrder: override ? Number(override.sort_order) : index * 10,
    };
  }).sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "zh-CN"));
}

// Public product information is an explicit allowlist, not a copy of internal
// adapter metadata. Acceptance status and future internal fields stay server-side.
function publicCatalogItem(item: ReturnType<typeof catalogItems>[number]) {
  return {
    id: item.id, name: item.name, kind: item.kind, category: item.category,
    accent: item.accent, version: item.version, memory: item.memory,
    port: item.port, description: item.description, enabled: item.enabled,
    supportedSystems: item.supportedSystems, operations: item.operations,
    capabilities: item.capabilities, requirements: item.requirements,
    form: item.form, steps: item.steps,
  };
}

export async function mountPanelArkApi(app: Express) {
  const dataDirectory = path.resolve(process.env.PANELARK_DATA_DIR || path.join(process.cwd(), "data"));
  const db = await PanelArkDatabase.open(path.join(dataDirectory, "panelark.sqlite"));
  let pepper = loadOrCreatePepper(dataDirectory);
  if (webInstallationEnabled()) ensureSetupToken(db, dataDirectory);
  seedCatalog(db);
  const jobEngine = new PanelArkJobEngine(db);
  const updateManager = new PanelArkUpdateManager(db, dataDirectory, loadUpdatePublicKey(dataDirectory));
  registerCatalogAdapters();
  // Both the receipt and plaintext delivery live only in memory, never cookies or storage.
  const adapterExecutions = new Map<string, { adapterId: string; operation: PanelAdapterOperation; payload: Record<string, any> }>();
  const adapterResults = new Map<string, unknown>();
  const deliveries = new Map<string, { job_id: string; result?: Record<string, unknown>; touched: number }>();
  // A queued automatic task cannot resume after a process restart without its SSH session.
  for (const row of db.all("SELECT id, grant_hash FROM deployment_jobs WHERE status IN ('queued','interrupted') AND json_extract(payload_json, '$.autoDeploy') = 1")) {
    db.transaction(() => {
      db.run("UPDATE deployment_jobs SET status = 'interrupted', recovery_status = 'manual', error_message = '服务重启中断了安装，请先检查目标服务器后重试' WHERE id = ?", [row.id]);
      db.run("UPDATE cdk_grants SET status = 'released', released_at = ? WHERE token_hash = ? AND status = 'locked'", [now(), row.grant_hash]);
    });
  }

  const router = express.Router();
  const auth = sessionMiddleware(db);
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
  const cdkLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

  const remoteApi = mountPanelArkRemoteApi(router, db);

  router.get("/setup/status", (_req, res) => res.json(installationStatus(db, dataDirectory)));

  router.get("/adapters", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, items: catalogItems(db).filter(item => item.enabled).map(publicCatalogItem) });
  });

  router.get("/adapters/:id", (req, res) => {
    const adapter = catalogItems(db).find(item => item.id === text(req.params.id, 80) && item.enabled);
    if (!adapter) return res.status(404).json({ success: false, error: "面板适配器不存在或已下架" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, adapter: publicCatalogItem(adapter) });
  });

  router.get("/resources", (_req, res) => {
    res.json({ success: true, items: db.all("SELECT id, type, title, description, badge, url, sort_order FROM recommended_resources WHERE enabled = 1 ORDER BY sort_order, created_at") });
  });

  router.get('/resources/:id/open', (req, res) => {
    const item = db.get('SELECT id, url FROM recommended_resources WHERE id = ? AND enabled = 1', [text(req.params.id, 80)]);
    if (!item) return res.status(404).json({ success: false, error: '推荐资源不存在或已下架' });
    const url = new URL(String(item.url));
    if (url.protocol !== 'https:' || url.username || url.password) return res.status(400).json({ success: false, error: '推荐资源地址无效' });
    db.run('UPDATE recommended_resources SET click_count = click_count + 1 WHERE id = ?', [item.id]);
    res.set('Cache-Control', 'no-store').redirect(302, url.toString());
  });

  router.post("/resources/:id/click", (req, res) => {
    const id = text(req.params.id, 80);
    const item = db.get<DbRow>("SELECT id, url FROM recommended_resources WHERE id = ? AND enabled = 1", [id]);
    if (!item) return res.status(404).json({ success: false, error: "推荐资源不存在或已下架" });
    db.run("UPDATE recommended_resources SET click_count = click_count + 1 WHERE id = ?", [id]);
    res.json({ success: true, url: item.url });
  });

  function resolveJobGrant(grantTokenValue: unknown, taskKeyValue: unknown) {
    const grantToken = text(grantTokenValue, 300);
    const taskKey = text(taskKeyValue, 180);
    if (!grantToken || !taskKey) throw new Error("缺少 CDK 授权或任务标识");
    const grant = db.get<DbRow>(
      `SELECT g.id, g.status, g.task_key, g.expires_at, p.allowed_panel, p.allowed_category
       FROM cdk_grants g
       JOIN cdks c ON c.id = g.cdk_id
       JOIN cdk_packages p ON p.id = c.package_id
       WHERE g.token_hash = ?`,
      [sha256(grantToken)],
    );
    if (!grant || grant.task_key !== taskKey || grant.status !== "locked" || String(grant.expires_at) <= now()) throw new Error("CDK 任务授权无效或已过期");
    return {
      grantToken,
      taskKey,
      grantHash: sha256(grantToken),
      allowedPanel: grant.allowed_panel ? String(grant.allowed_panel) : "",
      allowedCategory: grant.allowed_category ? String(grant.allowed_category) : "",
    };
  }

  const currentDelivery = (req: Request) => {
    // Polling keeps an open result alive indefinitely; abandoned pages leave no durable secret.
    const token = req.header('x-panelark-delivery');
    const receipt = token ? deliveries.get(sha256(token)) : undefined;
    if (receipt) receipt.touched = Date.now();
    for (const [key, value] of deliveries) {
      if (Date.now() - value.touched > 60 * 60_000 && !['queued', 'running', 'cancelling'].includes(jobEngine.getJob(value.job_id)?.status || '')) deliveries.delete(key);
    }
    return receipt;
  };
  router.get('/deployment/current', (req, res) => {
    try {
      const receipt = currentDelivery(req);
      if (!receipt) return res.set('Cache-Control', 'no-store').json({ success: true, job: null });
      const job = jobEngine.getJob(String(receipt.job_id));
      const cdk = db.get(`SELECT c.used_count, COALESCE(c.max_uses_override, p.max_uses) AS max_uses, c.id FROM cdks c JOIN cdk_packages p ON p.id = c.package_id JOIN cdk_grants g ON g.cdk_id = c.id JOIN deployment_jobs j ON j.grant_hash = g.token_hash WHERE j.id = ?`, [receipt.job_id]);
      const locked = cdk ? Number(db.get("SELECT COUNT(*) AS n FROM cdk_grants WHERE cdk_id = ? AND status = 'locked' AND expires_at > ?", [cdk.id, now()])?.n || 0) : 0;
      const usage = cdk ? { totalUses: Number(cdk.max_uses), usedCount: Number(cdk.used_count), lockedCount: locked, remaining: Math.max(0, Number(cdk.max_uses) - Number(cdk.used_count) - locked) } : undefined;
      res.set('Cache-Control', 'no-store').json({ success: true, job, result: receipt.result, usage });
    } catch { res.status(409).json({ success: false, error: '交付信息暂时无法读取，请保留此页面并联系管理员' }); }
  });
  router.post('/deployment/current/acknowledge', (req, res) => {
    const receipt = currentDelivery(req);
    if (!receipt || req.header('x-panelark-result') !== receipt.job_id) return res.status(403).json({ success: false, error: '无权关闭此部署结果' });
    const job = jobEngine.getJob(String(receipt.job_id));
    if (!job || ['queued', 'running', 'cancelling'].includes(job.status)) return res.status(409).json({ success: false, error: '任务仍在执行，不能关闭交付信息' });
    deliveries.delete(sha256(req.header('x-panelark-delivery')!));
    adapterResults.delete(String(receipt.job_id)); adapterExecutions.delete(String(receipt.job_id));
    res.json({ success: true });
  });

  function runRegisteredJob(jobId: string, grant: ReturnType<typeof resolveJobGrant>) {
    const execution = adapterExecutions.get(jobId);
    if (!execution) throw new Error('部署执行上下文已失效，请重新填写服务器信息');
    const automatic = execution.payload.autoDeploy === true;
    return jobEngine.startJob(jobId, async context => {
      const adapter = getPanelAdapter(execution.adapterId);
      if (!adapter) throw new Error('面板适配器不存在或已下架');
      if (!automatic) {
        const result = await adapter.execute(execution.operation, { ...context, payload: execution.payload });
        adapterResults.set(jobId, result);
        const expiry = setTimeout(() => adapterResults.delete(jobId), GRANT_MINUTES * 60_000); expiry.unref();
        return result;
      }
      const releaseLease = remoteApi.retain(grant.grantToken, execution.payload.serverSessionId);
      try {
        const result = await executeAutomaticDeployment(adapter, execution.payload, { ...context, payload: execution.payload }, {
          onDelivery: result => { for (const receipt of deliveries.values()) if (receipt.job_id === jobId) receipt.result = { ...result }; },
        });
        context.checkCancelled();
        for (const receipt of deliveries.values()) if (receipt.job_id === jobId) receipt.result = result;
        db.transaction(() => {
          const locked = db.get('SELECT id, cdk_id, status FROM cdk_grants WHERE token_hash = ? AND task_key = ?', [grant.grantHash, grant.taskKey]);
          if (!locked || !['locked', 'consumed'].includes(String(locked.status))) throw new Error('面板已安装，但授权核销未完成，请保存交付信息并联系管理员');
          if (locked.status === 'locked') {
            db.run("UPDATE cdk_grants SET status = 'consumed', consumed_at = ? WHERE id = ?", [now(), locked.id]);
            db.run('UPDATE cdks SET used_count = used_count + 1, updated_at = ? WHERE id = ?', [now(), locked.cdk_id]);
          }
        });
        // No login URL, password or bearer-link can be recovered from durable task history.
        return { adapterId: execution.adapterId, completed: true };
      } catch (error) {
        db.run("UPDATE cdk_grants SET status = 'released', released_at = ? WHERE token_hash = ? AND task_key = ? AND status = 'locked'", [now(), grant.grantHash, grant.taskKey]);
        throw error;
      } finally {
        releaseLease();
        try { remoteApi.disconnect(grant.grantToken, execution.payload.serverSessionId); } catch { /* TTL handles an already disconnected session. */ }
        adapterExecutions.delete(jobId);
      }
    });
  }

  router.post("/jobs", (req, res) => {
    try {
      const grant = resolveJobGrant(req.body?.grantToken, req.body?.taskKey);
      const adapterId = text(req.body?.adapterId, 80);
      const operation = text(req.body?.operation, 40) as PanelAdapterOperation;
      if (!adapterId) throw new Error("正式部署任务必须指定已注册的适配器");
      const catalogItem = catalogItems(db).find(item => item.id === adapterId && item.enabled);
      if (!catalogItem) throw new Error("面板适配器不存在或已下架");
      if (grant.allowedPanel && grant.allowedPanel !== adapterId) throw new Error("此 CDK 不支持所选面板或工具");
      if (grant.allowedCategory && grant.allowedCategory !== catalogItem.category) throw new Error("此 CDK 不支持所选分类");
      if (!["install", "create-node"].includes(operation) || !catalogItem.operations.includes(operation)) throw new Error("面板任务操作无效或当前适配器不支持此操作");
      const rawPayload = req.body?.payload && typeof req.body.payload === "object" ? { ...req.body.payload } : {};
      const executionPayload = { ...rawPayload };
      const automatic = rawPayload.autoDeploy === true;
      if (automatic && (operation !== 'install' || !executionPayload.serverSessionId)) throw new Error('自动部署需要已连接的服务器会话');
      if (automatic && currentDelivery(req)) throw new Error('还有未关闭的部署任务或结果，请先查看并关闭后再开始新任务');
      if (operation === "install" && executionPayload.serverSessionId) {
        executionPayload.sshSession = remoteApi.getSshSession(grant.grantToken, executionPayload.serverSessionId);
        const session = executionPayload.sshSession;
        executionPayload.ipOrDomain = session.host; executionPayload.sshPort = session.port; executionPayload.sshUser = session.user;
      }
      const job = jobEngine.createJob({
        kind: text(req.body?.kind, 80) || (operation === "create-node" ? "node-create" : "panel-install"),
        serverKey: executionPayload.sshSession ? `${executionPayload.sshSession.host}:${executionPayload.sshSession.port}` : text(req.body?.serverKey, 180),
        grantHash: grant.grantHash,
        taskKey: grant.taskKey,
        idempotencyKey: text(req.body?.idempotencyKey, 180) || `${grant.taskKey}:${text(req.body?.kind, 80) || operation || "panel-deployment"}`,
        payload: { ...rawPayload, adapterId, operation },
        steps: automatic ? [...automaticSteps, ...getPanelAdapterSteps(adapterId, operation), ...automaticFinalSteps] : getPanelAdapterSteps(adapterId, operation),
        timeoutMs: automatic ? 45 * 60_000 : req.body?.timeoutMs,
        maxAttempts: req.body?.maxAttempts,
      });
      if (!jobEngine.getJobForGrant(job.id, grant.grantHash)) throw new Error('任务标识已被其他授权使用，请重新开始');
      if (automatic && (job.status !== 'queued' || [...deliveries.values()].some(receipt => receipt.job_id === job.id))) throw new Error('同一安装任务已经创建，不会重复执行；请在原页面等待结果');
      adapterExecutions.set(job.id, { adapterId, operation, payload: executionPayload });
      if (automatic) {
        const receipt = randomSecret();
        deliveries.set(sha256(receipt), { job_id: job.id, touched: Date.now() });
        db.run("UPDATE cdk_grants SET expires_at = ? WHERE token_hash = ? AND status = 'locked'", [future(60), grant.grantHash]);
        try { runRegisteredJob(job.id, grant).catch(() => undefined); }
        catch (error) {
          jobEngine.cancelJob(job.id);
          db.run("UPDATE deployment_jobs SET status = 'failed', error_message = ? WHERE id = ?", [error instanceof Error ? error.message : '任务启动失败', job.id]);
          db.run("UPDATE cdk_grants SET status = 'released', released_at = ? WHERE token_hash = ? AND status = 'locked'", [now(), grant.grantHash]);
        }
        return res.status(201).set('Cache-Control', 'no-store').json({ success: true, job, receipt });
      }
      res.status(201).json({ success: true, job });
    } catch (error) { sendError(res, error, 409); }
  });

  router.get("/jobs", (req, res) => {
    try {
      const grantToken = text(req.query.grantToken, 300);
      if (!grantToken) throw new Error("缺少 CDK 授权");
      const grantHash = sha256(grantToken);
      const jobs = jobEngine.listJobs(200).filter(job => {
        const row = db.get<DbRow>("SELECT id FROM deployment_jobs WHERE id = ? AND grant_hash = ?", [job.id, grantHash]);
        return Boolean(row);
      });
      res.json({ success: true, items: jobs });
    } catch (error) { sendError(res, error, 401); }
  });

  router.get("/jobs/:id", (req, res) => {
    try {
      const grantToken = text(req.query.grantToken, 300);
      const job = jobEngine.getJobForGrant(text(req.params.id, 80), sha256(grantToken));
      if (!job) throw new Error("部署任务不存在或无权访问");
      res.json({ success: true, job });
    } catch (error) { sendError(res, error, 404); }
  });

  router.get("/jobs/:id/events", (req, res) => {
    try {
      const grantToken = text(req.query.grantToken || req.header("x-panelark-grant"), 300);
      const jobId = text(req.params.id, 80);
      if (!jobEngine.getJobForGrant(jobId, sha256(grantToken))) throw new Error("部署任务不存在或无权访问");
      attachJobSse(jobEngine, jobId, req, res);
    } catch (error) { sendError(res, error, 404); }
  });

  router.post("/jobs/:id/start", (req, res) => {
    try {
      const grant = resolveJobGrant(req.body?.grantToken, req.body?.taskKey);
      const job = jobEngine.getJobForGrant(text(req.params.id, 80), grant.grantHash);
      if (!job) throw new Error("部署任务不存在或无权访问");
      const execution = adapterExecutions.get(job.id);
      if (!execution) throw new Error("部署执行上下文已失效，请重新创建任务；系统不会在缺少凭据时继续执行");
      const run = runRegisteredJob(job.id, grant);
      run.catch(() => undefined);
      res.status(202).json({ success: true, job: jobEngine.getJob(job.id) });
    } catch (error) { sendError(res, error, 409); }
  });

  router.post("/jobs/:id/result", (req, res) => {
    try {
      const grant = resolveJobGrant(req.body?.grantToken, req.body?.taskKey);
      const job = jobEngine.getJobForGrant(text(req.params.id, 80), grant.grantHash);
      if (!job) throw new Error("部署任务不存在或无权访问");
      if (job.status !== "succeeded") throw new Error("部署任务尚未成功，不能读取交付结果");
      res.json({ success: true, result: adapterResults.get(job.id) || job.result || {}, live: adapterResults.has(job.id) });
    } catch (error) { sendError(res, error, 409); }
  });

  router.post("/jobs/:id/cancel", (req, res) => {
    try {
      const grant = resolveJobGrant(req.body?.grantToken, req.body?.taskKey);
      const job = jobEngine.getJobForGrant(text(req.params.id, 80), grant.grantHash);
      if (!job) throw new Error("部署任务不存在或无权访问");
      res.json({ success: true, job: jobEngine.cancelJob(job.id) });
    } catch (error) { sendError(res, error, 409); }
  });

  router.post("/jobs/:id/retry", (req, res) => {
    try {
      const grant = resolveJobGrant(req.body?.grantToken, req.body?.taskKey);
      const job = jobEngine.getJobForGrant(text(req.params.id, 80), grant.grantHash);
      if (!job) throw new Error("部署任务不存在或无权访问");
      res.json({ success: true, job: jobEngine.retryJob(job.id) });
    } catch (error) { sendError(res, error, 409); }
  });

  router.get("/public/config", (_req, res) => res.set("Cache-Control", "no-store").json({ success: true, ...getPublicSettings(db) }));

  // Resolve at click time: never trust a URL cached by an already-open frontend.
  router.get("/public/purchase", (_req, res) => {
    res.set("Cache-Control", "no-store");
    const settings = getPublicSettings(db);
    if (settings.purchaseEnabled && settings.purchaseUrl) {
      try {
        const url = new URL(settings.purchaseUrl);
        if (url.protocol === "https:" && !url.username && !url.password) return res.redirect(302, url.href);
      } catch { /* show a safe explanation below */ }
    }
    return res.status(settings.purchaseEnabled ? 503 : 404).type("html").send('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CDK 购买入口</title><body style="font:16px/1.8 system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:24px"><h1>购买入口暂不可用</h1><p>站点尚未开放购买，或管理员还未保存有效购买链接。请联系站点管理员。</p><a href="/">返回站点首页</a></body></html>');
  });

  router.post("/cdk/validate", cdkLimiter, (req, res) => {
    try {
      cleanup(db);
      const code = normalizeCdk(req.body?.code);
      if (!code.startsWith("PAK-") || code.length < 12) throw new Error("请输入有效的 PanelArk CDK");
      const row = db.get<DbRow>(
        `SELECT c.id, c.used_count, c.status, c.expires_at, p.name AS package_name, COALESCE(c.max_uses_override, p.max_uses) AS max_uses,
                p.allowed_panel, p.allowed_category, p.enabled AS package_enabled
         FROM cdks c JOIN cdk_packages p ON p.id = c.package_id WHERE c.code_hash = ?`,
        [hashCdk(code, pepper)],
      );
      if (!row || row.status !== "active" || Number(row.package_enabled) !== 1) throw new Error("CDK 无效或已停用");
      if (row.expires_at && String(row.expires_at) <= now()) throw new Error("CDK 已过期");
      const panelId = text(req.body?.panelId, 80);
      const category = text(req.body?.category, 80);
      if (row.allowed_panel && panelId && row.allowed_panel !== panelId) throw new Error("此 CDK 不支持所选面板");
      if (row.allowed_category && category && row.allowed_category !== category) throw new Error("此 CDK 不支持所选分类");
      const locked = db.get<DbRow>("SELECT COUNT(*) AS total FROM cdk_grants WHERE cdk_id = ? AND status = 'locked' AND expires_at > ?", [row.id, now()]);
      const remaining = Number(row.max_uses) - Number(row.used_count) - Number(locked?.total || 0);
      if (remaining <= 0) throw new Error("CDK 可用次数不足或已有任务占用额度");
      const grantToken = randomSecret();
      db.run(
        "INSERT INTO cdk_grants(id, cdk_id, token_hash, status, created_at, expires_at) VALUES (?, ?, ?, 'validated', ?, ?)",
        [randomUUID(), row.id, sha256(grantToken), now(), future(GRANT_MINUTES)],
      );
      res.set('Cache-Control', 'no-store').json({ success: true, grantToken, packageName: row.package_name, remaining, totalUses: Number(row.max_uses), usedCount: Number(row.used_count), lockedCount: Number(locked?.total || 0), expiresInMinutes: GRANT_MINUTES });
    } catch (error) { sendError(res, error); }
  });

  router.post("/cdk/lock", cdkLimiter, (req, res) => {
    try {
      const grantToken = text(req.body?.grantToken, 200);
      const taskKey = text(req.body?.taskKey, 100);
      if (!grantToken || !taskKey) throw new Error("缺少 CDK 授权或任务标识");
      const result = db.transaction(() => {
        cleanup(db);
        const grant = db.get<DbRow>(
          `SELECT g.id, g.cdk_id, g.status, g.task_key, g.expires_at, c.used_count, c.status AS cdk_status,
                  c.expires_at AS cdk_expires_at, COALESCE(c.max_uses_override, p.max_uses) AS max_uses, p.enabled AS package_enabled
           FROM cdk_grants g JOIN cdks c ON c.id = g.cdk_id JOIN cdk_packages p ON p.id = c.package_id
           WHERE g.token_hash = ?`, [sha256(grantToken)],
        );
        if (!grant || String(grant.expires_at) <= now()) throw new Error("CDK 验证已过期，请重新验证");
        if (grant.status === "locked" && grant.task_key === taskKey) return { lockId: grant.id, alreadyLocked: true };
        if (grant.status !== "validated") throw new Error("此 CDK 授权不能用于新任务");
        if (grant.cdk_status !== "active" || Number(grant.package_enabled) !== 1) throw new Error("CDK 已停用");
        if (grant.cdk_expires_at && String(grant.cdk_expires_at) <= now()) throw new Error("CDK 已过期");
        const active = db.get<DbRow>("SELECT COUNT(*) AS total FROM cdk_grants WHERE cdk_id = ? AND status = 'locked' AND expires_at > ?", [grant.cdk_id, now()]);
        if (Number(grant.used_count) + Number(active?.total || 0) >= Number(grant.max_uses)) throw new Error("CDK 可用次数已被占用");
        db.run("UPDATE cdk_grants SET status = 'locked', task_key = ?, locked_at = ?, expires_at = ? WHERE id = ?", [taskKey, now(), future(GRANT_MINUTES), grant.id]);
        return { lockId: grant.id, alreadyLocked: false };
      });
      res.json({ success: true, ...result });
    } catch (error) { sendError(res, error, 409); }
  });

  router.post("/cdk/release", cdkLimiter, (req, res) => {
    try {
      const grantToken = text(req.body?.grantToken, 200);
      const taskKey = text(req.body?.taskKey, 100);
      const grant = db.get<DbRow>("SELECT id, status, task_key FROM cdk_grants WHERE token_hash = ?", [sha256(grantToken)]);
      if (!grant || grant.task_key !== taskKey) throw new Error("找不到对应的 CDK 锁定任务");
      if (grant.status === "released") return res.json({ success: true, alreadyReleased: true });
      if (grant.status !== "locked") throw new Error("当前任务不能释放 CDK 权益");
      db.run("UPDATE cdk_grants SET status = 'released', released_at = ? WHERE id = ?", [now(), grant.id]);
      res.json({ success: true, alreadyReleased: false });
    } catch (error) { sendError(res, error, 409); }
  });

  router.post("/cdk/consume", cdkLimiter, (req, res) => {
    try {
      const grantToken = text(req.body?.grantToken, 200);
      const taskKey = text(req.body?.taskKey, 100);
      const result = db.transaction(() => {
        const grant = db.get<DbRow>("SELECT id, cdk_id, status, task_key FROM cdk_grants WHERE token_hash = ?", [sha256(grantToken)]);
        if (!grant || grant.task_key !== taskKey) throw new Error("找不到对应的 CDK 锁定任务");
        if (grant.status === "consumed") return { alreadyConsumed: true };
        if (grant.status !== "locked") throw new Error("当前任务没有锁定可核销权益");
        db.run("UPDATE cdk_grants SET status = 'consumed', consumed_at = ? WHERE id = ?", [now(), grant.id]);
        db.run("UPDATE cdks SET used_count = used_count + 1, updated_at = ? WHERE id = ?", [now(), grant.cdk_id]);
        return { alreadyConsumed: false };
      });
      for (const row of db.all<DbRow>("SELECT id FROM deployment_jobs WHERE task_key = ?", [taskKey])) adapterResults.delete(String(row.id));
      res.json({ success: true, ...result });
    } catch (error) { sendError(res, error, 409); }
  });

  router.get("/admin/bootstrap", (_req, res) => {
    const required = webInstallationEnabled() && installationRequired(db);
    res.json({ success: true, required, setupTokenRequired: required, terminalInitializationRequired: !webInstallationEnabled() && installationRequired(db) });
  });

  router.post("/admin/bootstrap", loginLimiter, async (req, res) => {
    if (!webInstallationEnabled()) return res.status(403).json({ success: false, error: "一键脚本部署请在 SSH 终端使用 pa init 初始化，网页安装已禁用" });
    try {
      if (db.get("SELECT id FROM admins LIMIT 1")) throw new Error("管理员已经初始化");
      const expected = db.get<DbRow>("SELECT value FROM site_settings WHERE key = 'admin_setup_token_hash'");
      if (!expected || !safeEqualString(sha256(text(req.body?.setupToken, 300)), String(expected.value))) throw new Error("初始化令牌无效");
      const username = normalizeUsername(req.body?.username);
      const password = validatePassword(req.body?.password);
      const installation = req.body?.installation === undefined ? undefined : installationSettings(req.body.installation);
      if (installation && !installationStatus(db, dataDirectory).ready) throw new Error("运行环境检查未通过，不能完成安装");
      const adminId = randomUUID();
      const timestamp = now();
      const passwordHash = await hashPassword(password);
      db.transaction(() => {
        if (!installationRequired(db)) throw new Error("管理员已经初始化，安装入口已锁定");
        db.run("INSERT INTO admins(id, username, password_hash, role, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, 'super_admin', ?, ?, ?)", [adminId, username, passwordHash, timestamp, timestamp, timestamp]);
        db.run("DELETE FROM site_settings WHERE key = 'admin_setup_token_hash'");
        if (installation) {
          for (const [key, value] of Object.entries({ site_name: installation.siteName, site_url: installation.siteUrl, admin_path: installation.adminPath, installation_completed_at: timestamp })) {
            db.run("INSERT OR REPLACE INTO site_settings(key, value, updated_at) VALUES (?, ?, ?)", [key, value, timestamp]);
          }
        }
      });
      fs.rmSync(path.join(dataDirectory, "admin-setup-token.txt"), { force: true });
      const session = createSession(db, req, adminId);
      setSessionCookie(req, res, session.token);
      audit(db, req, "admin.bootstrap", "admin", adminId, { username }, adminId);
      res.json({ success: true, csrfToken: session.csrfToken, adminPath: readAdminPath(db), admin: { id: adminId, username, role: "super_admin", totpEnabled: false } });
    } catch (error) { sendError(res, error); }
  });

  router.post("/admin/login", loginLimiter, async (req, res) => {
    try {
      const username = text(req.body?.username, 40);
      const password = String(req.body?.password || "");
      const admin = db.get<DbRow>("SELECT id, username, password_hash, role, enabled, totp_enabled, totp_secret FROM admins WHERE username = ? COLLATE NOCASE", [username]);
      if (!admin || Number(admin.enabled) !== 1 || !(await verifyPassword(password, String(admin.password_hash)))) {
        audit(db, req, "admin.login_failed", "admin", admin ? String(admin.id) : undefined, { username });
        throw new Error("用户名或密码错误");
      }
      if (Number(admin.totp_enabled) === 1) {
        if (!String(req.body?.totpCode || "").trim()) {
          return res.status(401).json({ success: false, code: "TOTP_REQUIRED", error: "此账号已启用双重验证，请输入验证器中的 6 位动态验证码" });
        }
        if (!admin.totp_secret || !verifyTotp(req.body?.totpCode, String(admin.totp_secret))) {
          audit(db, req, "admin.login_2fa_failed", "admin", String(admin.id), {}, String(admin.id));
          return res.status(401).json({ success: false, code: "TOTP_INVALID", error: "动态验证码无效，请核对后重试" });
        }
      }
      const session = createSession(db, req, String(admin.id));
      setSessionCookie(req, res, session.token);
      audit(db, req, "admin.login", "admin", String(admin.id), {}, String(admin.id));
      res.json({ success: true, csrfToken: session.csrfToken, admin: { id: admin.id, username: admin.username, role: admin.role, totpEnabled: Number(admin.totp_enabled) === 1 } });
    } catch (error) { sendError(res, error, 401); }
  });

  router.use("/admin", auth);
  router.use("/admin", requireCsrf);

  router.get("/admin/session", (req: AuthenticatedRequest, res) => {
    const state = db.get<DbRow>("SELECT totp_enabled FROM admins WHERE id = ?", [req.panelarkAdmin!.id]);
    res.json({ success: true, admin: { ...req.panelarkAdmin, totpEnabled: Number(state?.totp_enabled) === 1 }, csrfToken: req.panelarkAdmin?.csrfToken });
  });

  router.post("/admin/logout", (req: AuthenticatedRequest, res) => {
    db.run("DELETE FROM admin_sessions WHERE id = ?", [req.panelarkAdmin!.sessionId]);
    clearSessionCookie(req, res);
    res.json({ success: true });
  });

  router.get("/admin/dashboard", requirePermission("dashboard:read"), (_req, res) => {
    cleanup(db);
    const totalCdks = db.get<DbRow>("SELECT COUNT(*) AS total FROM cdks");
    const activeCdks = db.get<DbRow>("SELECT COUNT(*) AS total FROM cdks WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)", [now()]);
    const consumed = db.get<DbRow>("SELECT COALESCE(SUM(used_count), 0) AS total FROM cdks");
    const locked = db.get<DbRow>("SELECT COUNT(*) AS total FROM cdk_grants WHERE status = 'locked' AND expires_at > ?", [now()]);
    const jobsPendingReview = db.get<DbRow>("SELECT COUNT(*) AS total FROM deployment_jobs j LEFT JOIN job_reviews r ON r.job_id = j.id WHERE j.status IN ('failed','manual','interrupted','timed_out') AND (r.status IS NULL OR r.status <> 'resolved')");
    const resourceClicks = db.get<DbRow>("SELECT COALESCE(SUM(click_count), 0) AS total FROM recommended_resources");
    res.json({ success: true, stats: { totalCdks: Number(totalCdks?.total || 0), activeCdks: Number(activeCdks?.total || 0), consumed: Number(consumed?.total || 0), locked: Number(locked?.total || 0), jobsPendingReview: Number(jobsPendingReview?.total || 0), resourceClicks: Number(resourceClicks?.total || 0) } });
  });

  router.get("/admin/packages", requirePermission("cdk:read"), (req, res) => {
    res.json({ success: true, ...pagedSql(db, req, "SELECT * FROM cdk_packages ORDER BY created_at DESC, id", "SELECT COUNT(*) AS total FROM cdk_packages") });
  });

  router.post("/admin/packages", requirePermission("cdk:write"), (req: AuthenticatedRequest, res) => {
    try {
      const id = randomUUID();
      const name = text(req.body?.name, 80);
      if (!name) throw new Error("请输入套餐名称");
      const maxUses = Number(req.body?.maxUses ?? 1);
      const validityDays = req.body?.validityDays ? Number(req.body.validityDays) : null;
      if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 10000) throw new Error('最多部署次数需为 1 至 10000 的整数');
      if (validityDays !== null && (!Number.isSafeInteger(validityDays) || validityDays < 1 || validityDays > 3650)) throw new Error('有效天数需为 1 至 3650 的整数，0 表示永久有效');
      const timestamp = now();
      db.run(
        "INSERT INTO cdk_packages(id, name, description, max_uses, allowed_panel, allowed_category, validity_days, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
        [id, name, text(req.body?.description, 500), maxUses, text(req.body?.allowedPanel, 80) || null, text(req.body?.allowedCategory, 80) || null, validityDays, timestamp, timestamp],
      );
      audit(db, req, "cdk.package_create", "cdk_package", id, { name, maxUses }, req.panelarkAdmin!.id);
      res.json({ success: true, id });
    } catch (error) { sendError(res, error); }
  });

  router.patch("/admin/packages/:id", requirePermission("cdk:write"), (req: AuthenticatedRequest, res) => {
    try {
      const id = text(req.params.id, 80);
      const existing = db.get("SELECT id FROM cdk_packages WHERE id = ?", [id]);
      if (!existing) throw new Error("套餐不存在");
      db.run("UPDATE cdk_packages SET enabled = ?, updated_at = ? WHERE id = ?", [bool(req.body?.enabled) ? 1 : 0, now(), id]);
      audit(db, req, "cdk.package_update", "cdk_package", id, { enabled: bool(req.body?.enabled) }, req.panelarkAdmin!.id);
      res.json({ success: true });
    } catch (error) { sendError(res, error, 404); }
  });

  router.post("/admin/batches", requirePermission("cdk:write"), (req: AuthenticatedRequest, res) => {
    try {
      const packageId = text(req.body?.packageId, 80);
      const cdkPackage = db.get<DbRow>("SELECT * FROM cdk_packages WHERE id = ?", [packageId]);
      if (!cdkPackage) throw new Error("请选择有效套餐");
      const quantity = Number(req.body?.quantity ?? 1);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 500) throw new Error('生成数量需为 1 至 500 的整数');
      const batchId = randomUUID();
      const timestamp = now();
      const codes: string[] = [];
      db.transaction(() => {
        db.run("INSERT INTO cdk_batches(id, package_id, name, quantity, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", [batchId, packageId, text(req.body?.name, 80) || `批次 ${timestamp.slice(0, 10)}`, quantity, req.panelarkAdmin!.id, timestamp]);
        for (let index = 0; index < quantity; index += 1) {
          let code = generateCdkCode();
          while (db.get("SELECT id FROM cdks WHERE code_hash = ?", [hashCdk(code, pepper)])) code = generateCdkCode();
          const expiresAt = cdkPackage.validity_days ? new Date(Date.now() + Number(cdkPackage.validity_days) * 86_400_000).toISOString() : null;
          const id = randomUUID();
          db.run("INSERT INTO cdks(id, batch_id, package_id, code_hash, code_hint, code_encrypted, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)", [id, batchId, packageId, hashCdk(code, pepper), `…${code.slice(-4)}`, encryptCdkCode(code, pepper, id), expiresAt, timestamp, timestamp]);
          codes.push(code);
        }
      });
      audit(db, req, "cdk.batch_create", "cdk_batch", batchId, { packageId, quantity }, req.panelarkAdmin!.id);
      res.set('Cache-Control', 'no-store').json({ success: true, batchId, codes, warning: "CDK 已加密保存，管理员可随时重新查看、复制和导出" });
    } catch (error) { sendError(res, error); }
  });

  mountCdkManagement(router, db, () => pepper, {
    permission: requirePermission,
    audit: (req, action, target, details) => audit(db, req, action, 'cdk', target, details, (req as AuthenticatedRequest).panelarkAdmin!.id),
  });

  router.get("/admin/settings", requirePermission("settings:read"), (_req, res) => res.set("Cache-Control", "no-store").json({ success: true, ...getAdminSettings(db) }));

  router.put("/admin/settings", requirePermission("settings:write"), (req: AuthenticatedRequest, res) => {
    try {
      const purchaseUrl = text(req.body?.purchaseUrl, 500);
      const supportUrl = text(req.body?.supportUrl, 500);
      const previousAdminPath = readAdminPath(db);
      const adminPath = req.body?.adminPath === undefined ? previousAdminPath : normalizeAdminPath(req.body.adminPath);
      if (adminPath !== previousAdminPath && req.panelarkAdmin!.role !== "super_admin") {
        throw new Error("只有超级管理员可以修改后台路径");
      }
      for (const url of [purchaseUrl, supportUrl].filter(Boolean)) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("购买和客服链接必须使用不含账号密码的 HTTPS 地址");
      }
      const updates: Record<string, string> = {
        purchase_enabled: bool(req.body?.purchaseEnabled) ? "true" : "false",
        purchase_button_text: text(req.body?.purchaseButtonText, 40) || "购买 CDK",
        purchase_url: purchaseUrl,
        support_url: supportUrl,
        site_notice: text(req.body?.siteNotice, 500),
        admin_path: adminPath,
      };
      db.transaction(() => {
        for (const [key, value] of Object.entries(updates)) db.run("INSERT OR REPLACE INTO site_settings(key, value, updated_at) VALUES (?, ?, ?)", [key, value, now()]);
      });
      audit(db, req, "settings.update", "site_settings", undefined, { purchaseEnabled: bool(req.body?.purchaseEnabled), adminPathChanged: adminPath !== previousAdminPath }, req.panelarkAdmin!.id);
      res.set("Cache-Control", "no-store").json({ success: true, ...getAdminSettings(db) });
    } catch (error) { sendError(res, error); }
  });

  router.get("/admin/admins", requirePermission("*"), (req, res) => {
    res.json({ success: true, ...pagedSql(db, req, "SELECT id, username, role, enabled, created_at, updated_at FROM admins ORDER BY created_at, id", "SELECT COUNT(*) AS total FROM admins") });
  });

  router.post("/admin/admins", requirePermission("*"), async (req: AuthenticatedRequest, res) => {
    try {
      const username = normalizeUsername(req.body?.username);
      const password = validatePassword(req.body?.password);
      const role = text(req.body?.role, 30) as AdminRole;
      if (!ROLES.includes(role)) throw new Error("管理员角色无效");
      const id = randomUUID();
      const timestamp = now();
      db.run("INSERT INTO admins(id, username, password_hash, role, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, username, await hashPassword(password), role, timestamp, timestamp, timestamp]);
      audit(db, req, "admin.create", "admin", id, { username, role }, req.panelarkAdmin!.id);
      res.json({ success: true, id });
    } catch (error) { sendError(res, error); }
  });

  router.patch("/admin/admins/:id", requirePermission("*"), (req: AuthenticatedRequest, res) => {
    try {
      const id = text(req.params.id, 80);
      const existing = db.get<DbRow>("SELECT id, username, role, enabled FROM admins WHERE id = ?", [id]);
      if (!existing) throw new Error("管理员不存在");
      const role = text(req.body?.role ?? existing.role, 30) as AdminRole;
      const enabled = req.body?.enabled === undefined ? Number(existing.enabled) === 1 : bool(req.body.enabled);
      if (!ROLES.includes(role)) throw new Error("管理员角色无效");
      if (id === req.panelarkAdmin!.id && !enabled) throw new Error("不能停用当前登录账号");
      if (id === req.panelarkAdmin!.id && role !== "super_admin") throw new Error("不能降低当前超级管理员自身权限");
      db.transaction(() => {
        db.run("UPDATE admins SET role = ?, enabled = ?, updated_at = ? WHERE id = ?", [role, enabled ? 1 : 0, now(), id]);
        if (!enabled) db.run("DELETE FROM admin_sessions WHERE admin_id = ?", [id]);
      });
      audit(db, req, "admin.update", "admin", id, { role, enabled }, req.panelarkAdmin!.id);
      res.json({ success: true });
    } catch (error) { sendError(res, error); }
  });

  router.get("/admin/catalog", requirePermission("settings:read"), (req, res) => {
    const all = catalogItems(db), meta = pagination(req.query, all.length);
    res.json({ success: true, items: all.slice((meta.page - 1) * meta.pageSize, meta.page * meta.pageSize), pagination: meta });
  });

  router.put("/admin/catalog/:id", requirePermission("catalog:write"), (req: AuthenticatedRequest, res) => {
    try {
      const id = text(req.params.id, 80);
      const base = getPanelAdapter(id)?.metadata;
      if (!base) throw new Error("面板适配器不存在");
      const name = text(req.body?.name, 80) || base.name;
      const description = text(req.body?.description, 500) || base.description;
      const category = text(req.body?.category, 80) || base.category;
      const enabled = req.body?.enabled === undefined ? base.enabled : bool(req.body.enabled);
      const sortOrder = Math.max(0, Math.min(10_000, Number(req.body?.sortOrder ?? 100)));
      db.run(
        `INSERT OR REPLACE INTO catalog_overrides(adapter_id, name, description, category, enabled, sort_order, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, description, category, enabled ? 1 : 0, sortOrder, req.panelarkAdmin!.id, now()],
      );
      audit(db, req, "catalog.update", "adapter", id, { name, category, enabled, sortOrder }, req.panelarkAdmin!.id);
      res.json({ success: true, item: catalogItems(db).find(item => item.id === id) });
    } catch (error) { sendError(res, error, 404); }
  });

  router.get("/admin/resources", requirePermission("settings:read"), (req, res) => {
    res.json({ success: true, ...pagedSql(db, req, "SELECT * FROM recommended_resources ORDER BY sort_order, created_at, id", "SELECT COUNT(*) AS total FROM recommended_resources") });
  });

  router.post("/admin/resources", requirePermission("resources:write"), (req: AuthenticatedRequest, res) => {
    try {
      const url = text(req.body?.url, 500);
      if (new URL(url).protocol !== "https:") throw new Error("推荐链接必须使用 HTTPS");
      const type = text(req.body?.type, 20) || "other";
      if (!["vps", "domain", "cdn", "other"].includes(type)) throw new Error("推荐资源类型无效");
      const id = randomUUID();
      db.run(
        `INSERT INTO recommended_resources(id, type, title, description, badge, url, enabled, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, type, text(req.body?.title, 80), text(req.body?.description, 300), text(req.body?.badge, 40), url, bool(req.body?.enabled ?? true) ? 1 : 0, Number(req.body?.sortOrder || 100), now(), now()],
      );
      audit(db, req, "resource.create", "resource", id, { type, url }, req.panelarkAdmin!.id);
      res.status(201).json({ success: true, id });
    } catch (error) { sendError(res, error); }
  });

  router.put("/admin/resources/:id", requirePermission("resources:write"), (req: AuthenticatedRequest, res) => {
    try {
      const id = text(req.params.id, 80);
      const existing = db.get<DbRow>("SELECT * FROM recommended_resources WHERE id = ?", [id]);
      if (!existing) throw new Error("推荐资源不存在");
      const url = text(req.body?.url ?? existing.url, 500);
      if (new URL(url).protocol !== "https:") throw new Error("推荐链接必须使用 HTTPS");
      const type = text(req.body?.type ?? existing.type, 20);
      if (!["vps", "domain", "cdn", "other"].includes(type)) throw new Error("推荐资源类型无效");
      db.run(
        `UPDATE recommended_resources SET type = ?, title = ?, description = ?, badge = ?, url = ?, enabled = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
        [type, text(req.body?.title ?? existing.title, 80), text(req.body?.description ?? existing.description, 300), text(req.body?.badge ?? existing.badge, 40), url, bool(req.body?.enabled ?? existing.enabled) ? 1 : 0, Number(req.body?.sortOrder ?? existing.sort_order), now(), id],
      );
      audit(db, req, "resource.update", "resource", id, { type, url }, req.panelarkAdmin!.id);
      res.json({ success: true });
    } catch (error) { sendError(res, error, 404); }
  });

  router.delete("/admin/resources/:id", requirePermission("resources:write"), (req: AuthenticatedRequest, res) => {
    const id = text(req.params.id, 80);
    db.run("DELETE FROM recommended_resources WHERE id = ?", [id]);
    audit(db, req, "resource.delete", "resource", id, {}, req.panelarkAdmin!.id);
    res.json({ success: true });
  });

  router.get("/admin/jobs", requirePermission("jobs:read"), (req, res) => {
    const result = pagedSql(db, req,
      `SELECT j.id, j.kind, j.status, j.recovery_status, j.progress, j.error_message, j.task_key, j.created_at, j.updated_at,
              r.status AS review_status, r.refund_status, r.note
       FROM deployment_jobs j LEFT JOIN job_reviews r ON r.job_id = j.id ORDER BY j.created_at DESC, j.id`,
      "SELECT COUNT(*) AS total FROM deployment_jobs",
    );
    res.json({ success: true, ...result });
  });

  router.put("/admin/jobs/:id/review", requirePermission("jobs:review"), (req: AuthenticatedRequest, res) => {
    try {
      const jobId = text(req.params.id, 80);
      if (!db.get("SELECT id FROM deployment_jobs WHERE id = ?", [jobId])) throw new Error("部署任务不存在");
      const status = text(req.body?.status, 20) || "reviewed";
      if (!["pending", "reviewed", "resolved"].includes(status)) throw new Error("审核状态无效");
      const existing = db.get<DbRow>("SELECT id, refund_status, created_at FROM job_reviews WHERE job_id = ?", [jobId]);
      db.run(
        `INSERT OR REPLACE INTO job_reviews(id, job_id, status, refund_status, note, reviewed_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [existing?.id || randomUUID(), jobId, status, existing?.refund_status || "none", text(req.body?.note, 1000), req.panelarkAdmin!.id, existing?.created_at || now(), now()],
      );
      audit(db, req, "job.review", "deployment_job", jobId, { status }, req.panelarkAdmin!.id);
      res.json({ success: true });
    } catch (error) { sendError(res, error, 404); }
  });

  router.post("/admin/jobs/:id/refund", requirePermission("jobs:review"), (req: AuthenticatedRequest, res) => {
    try {
      const jobId = text(req.params.id, 80);
      const job = db.get<DbRow>("SELECT id, task_key FROM deployment_jobs WHERE id = ?", [jobId]);
      if (!job?.task_key) throw new Error("任务没有可返还的 CDK 记录");
      const result = db.transaction(() => {
        const grant = db.get<DbRow>("SELECT id, cdk_id, status FROM cdk_grants WHERE task_key = ?", [job.task_key]);
        if (!grant) throw new Error("找不到任务对应的 CDK 权益");
        const review = db.get<DbRow>("SELECT id, refund_status, created_at FROM job_reviews WHERE job_id = ?", [jobId]);
        if (review?.refund_status === "refunded") return { alreadyRefunded: true };
        if (grant.status === "consumed") db.run("UPDATE cdks SET used_count = MAX(0, used_count - 1), updated_at = ? WHERE id = ?", [now(), grant.cdk_id]);
        if (["consumed", "locked"].includes(String(grant.status))) db.run("UPDATE cdk_grants SET status = 'released', released_at = ? WHERE id = ?", [now(), grant.id]);
        db.run(
          `INSERT OR REPLACE INTO job_reviews(id, job_id, status, refund_status, note, reviewed_by, created_at, updated_at)
           VALUES (?, ?, 'resolved', 'refunded', ?, ?, ?, ?)`,
          [review?.id || randomUUID(), jobId, text(req.body?.note, 1000) || "售后审核返还 CDK 权益", req.panelarkAdmin!.id, review?.created_at || now(), now()],
        );
        return { alreadyRefunded: false };
      });
      audit(db, req, "job.refund", "deployment_job", jobId, result, req.panelarkAdmin!.id);
      res.json({ success: true, ...result });
    } catch (error) { sendError(res, error, 409); }
  });

  router.get("/admin/sessions", (req: AuthenticatedRequest, res) => {
    const result = pagedSql(db, req, "SELECT id, ip, user_agent, created_at, last_seen_at, expires_at FROM admin_sessions WHERE admin_id = ? ORDER BY last_seen_at DESC, id", "SELECT COUNT(*) AS total FROM admin_sessions WHERE admin_id = ?", [req.panelarkAdmin!.id]);
    res.json({ success: true, currentSessionId: req.panelarkAdmin!.sessionId, ...result });
  });

  router.delete("/admin/sessions/:id", (req: AuthenticatedRequest, res) => {
    const id = text(req.params.id, 80);
    db.run("DELETE FROM admin_sessions WHERE id = ? AND admin_id = ?", [id, req.panelarkAdmin!.id]);
    audit(db, req, "admin.session_revoke", "admin_session", id, {}, req.panelarkAdmin!.id);
    if (id === req.panelarkAdmin!.sessionId) clearSessionCookie(req, res);
    res.json({ success: true, currentRevoked: id === req.panelarkAdmin!.sessionId });
  });

  router.post("/admin/2fa/setup", async (req: AuthenticatedRequest, res) => {
    try {
      const admin = db.get<DbRow>("SELECT username, password_hash FROM admins WHERE id = ?", [req.panelarkAdmin!.id]);
      if (!admin || !(await verifyPassword(String(req.body?.currentPassword || ""), String(admin.password_hash)))) throw new Error("当前密码错误");
      const secret = generateTotpSecret();
      db.run("UPDATE admins SET totp_secret = ?, totp_enabled = 0, updated_at = ? WHERE id = ?", [secret, now(), req.panelarkAdmin!.id]);
      const issuer = "PanelArk";
      const uri = `otpauth://totp/${issuer}:${encodeURIComponent(String(admin.username))}?secret=${secret}&issuer=${issuer}&digits=6&period=30`;
      audit(db, req, "admin.2fa_setup", "admin", req.panelarkAdmin!.id, {}, req.panelarkAdmin!.id);
      res.json({ success: true, secret, uri });
    } catch (error) { sendError(res, error); }
  });

  router.post("/admin/2fa/enable", (req: AuthenticatedRequest, res) => {
    try {
      const admin = db.get<DbRow>("SELECT totp_secret FROM admins WHERE id = ?", [req.panelarkAdmin!.id]);
      if (!admin?.totp_secret || !verifyTotp(req.body?.code, String(admin.totp_secret))) throw new Error("2FA 动态验证码无效");
      db.run("UPDATE admins SET totp_enabled = 1, updated_at = ? WHERE id = ?", [now(), req.panelarkAdmin!.id]);
      audit(db, req, "admin.2fa_enable", "admin", req.panelarkAdmin!.id, {}, req.panelarkAdmin!.id);
      res.json({ success: true });
    } catch (error) { sendError(res, error); }
  });

  router.delete("/admin/2fa", async (req: AuthenticatedRequest, res) => {
    try {
      const admin = db.get<DbRow>("SELECT password_hash, totp_secret, totp_enabled FROM admins WHERE id = ?", [req.panelarkAdmin!.id]);
      if (!admin || !(await verifyPassword(String(req.body?.currentPassword || ""), String(admin.password_hash)))) throw new Error("当前密码错误");
      if (Number(admin.totp_enabled) === 1 && !verifyTotp(req.body?.code, String(admin.totp_secret || ""))) throw new Error("2FA 动态验证码无效");
      db.run("UPDATE admins SET totp_secret = NULL, totp_enabled = 0, updated_at = ? WHERE id = ?", [now(), req.panelarkAdmin!.id]);
      audit(db, req, "admin.2fa_disable", "admin", req.panelarkAdmin!.id, {}, req.panelarkAdmin!.id);
      res.json({ success: true });
    } catch (error) { sendError(res, error); }
  });

  router.get("/admin/backups", requirePermission("*"), (req, res) => {
    res.json({ success: true, ...pagedSql(db, req, "SELECT * FROM backup_records ORDER BY created_at DESC, id", "SELECT COUNT(*) AS total FROM backup_records") });
  });

  router.get("/admin/update/status", requirePermission("*"), (_req, res) => {
    const state = updateManager.status();
    const adapterVersion = db.get<DbRow>("SELECT value FROM site_settings WHERE key = 'adapter_catalog_version'");
    res.json({ success: true, state, ...applicationUpdatePolicy(), adapterCatalogVersion: String(adapterVersion?.value || "built-in"), signingConfigured: Boolean(loadUpdatePublicKey(dataDirectory)) });
  });

  router.get("/admin/security/report", requirePermission("*"), (_req, res) => {
    res.json({ success: true, report: buildSecurityReport(db, dataDirectory, Boolean(loadUpdatePublicKey(dataDirectory))) });
  });

  router.post("/admin/update/check", requirePermission("*"), async (req: AuthenticatedRequest, res) => {
    try {
      const channel = text(req.body?.channel, 20) as UpdateChannel;
      if (channel !== "stable") throw new Error("正式版仅支持稳定更新通道");
      const state = await updateManager.check(channel);
      audit(db, req, "update.check", "system", undefined, { channel, targetVersion: state.targetVersion }, req.panelarkAdmin!.id);
      res.json({ success: true, state });
    } catch (error) { sendError(res, error); }
  });

  router.post("/admin/update/prepare", requirePermission("*"), async (req: AuthenticatedRequest, res) => {
    try {
      const state = await updateManager.prepare(req.panelarkAdmin!.id);
      audit(db, req, "update.prepare", "system", undefined, { targetVersion: state.targetVersion, preUpdateBackup: state.preUpdateBackup }, req.panelarkAdmin!.id);
      res.json({ success: true, state });
    } catch (error) { sendError(res, error); }
  });

  router.post("/admin/update/apply", requirePermission("*"), (req: AuthenticatedRequest, res) => {
    try {
      const state = updateManager.apply();
      audit(db, req, "update.apply", "system", undefined, { targetVersion: state.targetVersion }, req.panelarkAdmin!.id);
      res.status(202).json({ success: true, state });
    } catch (error) { sendError(res, error, 409); }
  });

  router.post("/admin/update/adapters", requirePermission("*"), async (req: AuthenticatedRequest, res) => {
    try {
      const result = await updateManager.applyAdapterCatalog(req.panelarkAdmin!.id);
      audit(db, req, "update.adapters", "adapter_catalog", result.version, result, req.panelarkAdmin!.id);
      res.json({ success: true, ...result });
    } catch (error) { sendError(res, error); }
  });

  router.get("/admin/backup-schedule", requirePermission("*"), (_req, res) => {
    const enabled = db.get<DbRow>("SELECT value FROM site_settings WHERE key = 'backup_schedule_enabled'");
    const last = db.get<DbRow>("SELECT value FROM site_settings WHERE key = 'backup_last_scheduled_at'");
    res.json({ success: true, enabled: enabled?.value === "true", configured: Boolean(process.env.PANELARK_BACKUP_PASSPHRASE), lastRunAt: String(last?.value || "") });
  });

  router.put("/admin/backup-schedule", requirePermission("*"), (req: AuthenticatedRequest, res) => {
    if (bool(req.body?.enabled) && !process.env.PANELARK_BACKUP_PASSPHRASE) return res.status(400).json({ success: false, error: "启用定时备份前请配置 PANELARK_BACKUP_PASSPHRASE" });
    db.run("INSERT OR REPLACE INTO site_settings(key, value, updated_at) VALUES ('backup_schedule_enabled', ?, ?)", [bool(req.body?.enabled) ? "true" : "false", now()]);
    audit(db, req, "backup.schedule_update", "site_settings", "backup_schedule_enabled", { enabled: bool(req.body?.enabled) }, req.panelarkAdmin!.id);
    res.json({ success: true, enabled: bool(req.body?.enabled) });
  });

  router.post("/admin/backups", requirePermission("*"), (req: AuthenticatedRequest, res) => {
    try {
      const reason = ["manual", "pre_update"].includes(text(req.body?.reason, 30)) ? text(req.body.reason, 30) as "manual" | "pre_update" : "manual";
      const record = saveBackup(db, dataDirectory, String(req.body?.passphrase || ""), reason, req.panelarkAdmin!.id);
      audit(db, req, "backup.create", "backup", record.id, { reason, sizeBytes: record.sizeBytes }, req.panelarkAdmin!.id);
      res.status(201).json({ success: true, item: { id: record.id, filename: record.filename, reason, size_bytes: record.sizeBytes } });
    } catch (error) { sendError(res, error); }
  });

  router.post("/admin/backups/upload", requirePermission("*"), express.raw({ type: "application/octet-stream", limit: backupLimits.maxArchiveBytes }), (req: AuthenticatedRequest, res) => {
    try {
      const archive = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!isBackupArchive(archive)) throw new Error("不是有效的 PanelArk .pgbak 文件");
      const backupDirectory = path.join(dataDirectory, "backups");
      fs.mkdirSync(backupDirectory, { recursive: true });
      const id = randomUUID();
      const filename = `uploaded-${id}.pgbak`;
      fs.writeFileSync(path.join(backupDirectory, filename), archive, { mode: 0o600 });
      db.run("INSERT INTO backup_records(id, filename, reason, size_bytes, created_by, created_at) VALUES (?, ?, 'uploaded', ?, ?, ?)", [id, filename, archive.length, req.panelarkAdmin!.id, now()]);
      audit(db, req, "backup.upload", "backup", id, { sizeBytes: archive.length }, req.panelarkAdmin!.id);
      res.status(201).json({ success: true, id, filename });
    } catch (error) { sendError(res, error); }
  });

  router.get("/admin/backups/:id/download", requirePermission("*"), (req, res) => {
    try {
      const record = db.get<DbRow>("SELECT filename FROM backup_records WHERE id = ?", [text(req.params.id, 80)]);
      if (!record) throw new Error("备份不存在");
      const filename = String(record.filename);
      res.download(backupFilePath(dataDirectory, filename), filename);
    } catch (error) { sendError(res, error, 404); }
  });

  router.post("/admin/backups/:id/preview", requirePermission("*"), (req, res) => {
    try {
      const record = db.get<DbRow>("SELECT filename, reason FROM backup_records WHERE id = ?", [text(req.params.id, 80)]);
      if (!record) throw new Error("备份不存在");
      const passphrase = backupPassphraseForRecord(dataDirectory, record.reason, req.body?.passphrase);
      const preview = backupPreview(fs.readFileSync(backupFilePath(dataDirectory, String(record.filename))), passphrase);
      res.json({ success: true, preview });
    } catch (error) { sendError(res, error); }
  });

  router.post("/admin/backups/:id/restore", requirePermission("*"), (req: AuthenticatedRequest, res) => {
    const secretPath = path.join(dataDirectory, "panelark.secret");
    const previousDatabase = db.exportBytes();
    const previousSecret = fs.readFileSync(secretPath);
    const previousPepper = pepper;
    try {
      const record = db.get<DbRow>("SELECT filename, reason FROM backup_records WHERE id = ?", [text(req.params.id, 80)]);
      if (!record) throw new Error("备份不存在");
      const managed = ["managed_pre_update", "managed_pre_restore"].includes(String(record.reason));
      const passphrase = backupPassphraseForRecord(dataDirectory, record.reason, req.body?.passphrase);
      const archive = fs.readFileSync(backupFilePath(dataDirectory, String(record.filename)));
      const payload = decryptBackup(archive, passphrase);
      const snapshot = managed
        ? saveManagedBackup(db, dataDirectory, "managed_pre_restore", req.panelarkAdmin!.id)
        : saveBackup(db, dataDirectory, passphrase, "pre_restore", req.panelarkAdmin!.id);
      const restoredSecret = Buffer.from(payload.cdkPepper, "base64");
      if (restoredSecret.length < 16) throw new Error("备份中的 CDK 密钥无效");
      if (process.env.PANELARK_CDK_PEPPER?.trim() && !Buffer.from(process.env.PANELARK_CDK_PEPPER.trim(), 'utf8').equals(restoredSecret)) throw new Error('环境变量 PANELARK_CDK_PEPPER 与备份密钥不同，请先同步配置后再恢复');
      db.replaceFromBytes(Buffer.from(payload.database, "base64"));
      fs.writeFileSync(secretPath, restoredSecret, { mode: 0o600 });
      pepper = restoredSecret;
      const restoredAdminId = db.get("SELECT id FROM admins WHERE id = ?", [req.panelarkAdmin!.id]) ? req.panelarkAdmin!.id : undefined;
      audit(db, req, "backup.restore", "backup", text(req.params.id, 80), { preRestoreSnapshot: snapshot.filename, initiatedBy: req.panelarkAdmin!.username }, restoredAdminId);
      res.json({ success: true, preRestoreSnapshot: snapshot.filename, message: "核心业务数据已恢复，请重新登录确认" });
    } catch (error) {
      try { db.replaceFromBytes(previousDatabase); fs.writeFileSync(secretPath, previousSecret, { mode: 0o600 }); } catch { /* preserve original error */ }
      pepper = previousPepper;
      sendError(res, error, 409);
    }
  });

  router.put("/admin/account", async (req: AuthenticatedRequest, res) => {
    try {
      const admin = db.get<DbRow>("SELECT * FROM admins WHERE id = ?", [req.panelarkAdmin!.id]);
      if (!admin || !(await verifyPassword(String(req.body?.currentPassword || ""), String(admin.password_hash)))) throw new Error("当前密码错误");
      const username = req.body?.username ? normalizeUsername(req.body.username) : String(admin.username);
      const newPassword = req.body?.newPassword ? validatePassword(req.body.newPassword) : null;
      const passwordHash = newPassword ? await hashPassword(newPassword) : String(admin.password_hash);
      db.transaction(() => {
        db.run("UPDATE admins SET username = ?, password_hash = ?, updated_at = ?, password_changed_at = ? WHERE id = ?", [username, passwordHash, now(), newPassword ? now() : admin.password_changed_at, admin.id]);
        if (newPassword) db.run("DELETE FROM admin_sessions WHERE admin_id = ? AND id <> ?", [admin.id, req.panelarkAdmin!.sessionId]);
      });
      audit(db, req, "admin.account_update", "admin", String(admin.id), { usernameChanged: username !== admin.username, passwordChanged: Boolean(newPassword) }, req.panelarkAdmin!.id);
      res.json({ success: true, admin: { id: admin.id, username, role: admin.role, totpEnabled: Number(admin.totp_enabled) === 1 } });
    } catch (error) { sendError(res, error); }
  });

  router.get("/admin/audit", requirePermission("audit:read"), (req, res) => {
    res.json({ success: true, ...pagedSql(db, req, "SELECT l.*, a.username FROM audit_logs l LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.id DESC", "SELECT COUNT(*) AS total FROM audit_logs") });
  });

  const scheduledBackupTimer = setInterval(() => {
    try {
      const enabled = db.get<DbRow>("SELECT value FROM site_settings WHERE key = 'backup_schedule_enabled'")?.value === "true";
      const passphrase = process.env.PANELARK_BACKUP_PASSPHRASE;
      const lastRunAt = String(db.get<DbRow>("SELECT value FROM site_settings WHERE key = 'backup_last_scheduled_at'")?.value || "");
      if (!enabled || !passphrase || (lastRunAt && Date.now() - Date.parse(lastRunAt) < 23 * 60 * 60_000)) return;
      saveBackup(db, dataDirectory, passphrase, "scheduled");
      db.run("INSERT OR REPLACE INTO site_settings(key, value, updated_at) VALUES ('backup_last_scheduled_at', ?, ?)", [now(), now()]);
    } catch (error) { console.error("[PanelArk] 定时备份失败", error); }
  }, 60 * 60_000);
  scheduledBackupTimer.unref();

  app.use("/api", router);
  return { db, dataDirectory, jobEngine, updateManager };
}
