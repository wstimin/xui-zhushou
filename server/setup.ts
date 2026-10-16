import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PanelArkDatabase } from "./panelark-db.js";
import { normalizeAdminPath } from "./admin-path.js";

export function installationRequired(db: PanelArkDatabase) {
  return !db.get("SELECT id FROM admins LIMIT 1");
}

export function webInstallationEnabled() {
  return ["panel", "docker"].includes(process.env.PANELARK_DEPLOYMENT_MODE || "standalone");
}

export function installationSettings(input: unknown) {
  const value = input as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("安装信息无效");
  const siteName = String(value.siteName || "PanelArk 面板方舟").trim();
  if (!siteName || siteName.length > 80) throw new Error("站点名称需为 1 至 80 位");
  let siteUrl: URL;
  try { siteUrl = new URL(String(value.siteUrl || "")); } catch { throw new Error("请输入完整站点地址，例如 https://panel.example.com"); }
  if (!["http:", "https:"].includes(siteUrl.protocol) || siteUrl.username || siteUrl.password || siteUrl.search || siteUrl.hash || siteUrl.pathname !== "/") {
    throw new Error("站点地址仅支持 HTTP/HTTPS 域名或 IP 根地址，不能包含账号、路径或参数");
  }
  return { siteName, siteUrl: siteUrl.origin, adminPath: normalizeAdminPath(value.adminPath || "/admin") };
}

export function installationStatus(db: PanelArkDatabase, dataDirectory: string) {
  if (!webInstallationEnabled()) return { success: true, enabled: false, required: false, initializationRequired: installationRequired(db), checks: [], ready: false };
  if (!installationRequired(db)) return { success: true, required: false, checks: [], ready: false };
  const checks: Array<{ id: string; label: string; passed: boolean; detail: string }> = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ id: "node", label: "Node.js 运行环境", passed: major >= 24, detail: `当前 ${process.version}，需要 Node.js 24 或更高版本` });
  let databaseReady = false;
  try { databaseReady = Number(db.get("SELECT 1 AS ready")?.ready) === 1; } catch { /* reported below */ }
  checks.push({ id: "database", label: "内置 SQLite 数据库", passed: databaseReady, detail: databaseReady ? "连接正常，无需创建 MySQL 数据库" : "数据库不可用，请检查运行日志" });
  const probe = path.join(dataDirectory, `.setup-write-${randomUUID()}`);
  let writable = false;
  try { fs.writeFileSync(probe, "ok", { flag: "wx", mode: 0o600 }); fs.unlinkSync(probe); writable = true; } catch { /* reported below */ }
  checks.push({ id: "storage", label: "数据目录写入权限", passed: writable, detail: writable ? "运行用户可以保存配置与业务数据" : "请在面板给运行用户授予数据目录写入权限" });
  let secretReady = false;
  try { secretReady = fs.readFileSync(path.join(dataDirectory, "panelark.secret")).length >= 16; } catch { /* reported below */ }
  checks.push({ id: "secret", label: "业务加密密钥", passed: secretReady, detail: secretReady ? "已生成并可读取" : "密钥不可用，请检查数据目录权限" });
  return { success: true, required: true, ready: checks.every(item => item.passed), checks, deploymentMode: process.env.PANELARK_DEPLOYMENT_MODE || "standalone", database: "SQLite", tokenHint: "在面板文件管理器打开数据目录下的 admin-setup-token.txt；如设置了 PANELARK_SETUP_TOKEN，则使用该值。令牌不会通过网页或普通日志公开。" };
}

export function applicationUpdatePolicy() {
  const managed = ["panel", "docker"].includes(process.env.PANELARK_DEPLOYMENT_MODE || "");
  return {
    applicationUpdateSupported: !managed,
    applicationUpdateHint: managed ? "当前由宝塔 / 1Panel 或容器管理：请在面板中停止项目、备份数据、替换程序包或重新构建镜像后启动。签名检查、适配器目录更新与数据备份仍可使用。" : "可通过后台下载签名构建包并由 systemd 完成更新与回滚。",
  };
}
