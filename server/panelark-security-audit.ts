import fs from "node:fs";
import path from "node:path";
import { PanelArkDatabase, DbRow } from "./panelark-db.js";

export type SecurityCheck = { id: string; label: string; status: "pass" | "warning" | "fail"; detail: string };

export function buildSecurityReport(db: PanelArkDatabase, dataDirectory: string, signingConfigured: boolean) {
  const checks: SecurityCheck[] = [];
  const production = process.env.NODE_ENV === "production";
  const httpsConfigured = Boolean(process.env.SSL_CERT && process.env.SSL_KEY) || process.env.PANELARK_TRUST_PROXY === "true";
  checks.push({ id: "https", label: "HTTPS 传输", status: !production || httpsConfigured ? "pass" : "fail", detail: !production ? "开发环境" : httpsConfigured ? "已配置证书或可信反向代理" : "生产环境未配置 HTTPS" });
  checks.push({ id: "https-enforcement", label: "HTTPS 强制", status: !production || process.env.PANELARK_REQUIRE_HTTPS === "true" ? "pass" : "warning", detail: process.env.PANELARK_REQUIRE_HTTPS === "true" ? "已拒绝明文生产请求" : "建议启用 PANELARK_REQUIRE_HTTPS" });
  checks.push({ id: "updates", label: "更新签名", status: signingConfigured ? "pass" : "fail", detail: signingConfigured ? "已加载 Ed25519 发布公钥" : "在线更新已安全禁用" });
  checks.push({ id: "backups", label: "定时备份密钥", status: process.env.PANELARK_BACKUP_PASSPHRASE ? "pass" : "warning", detail: process.env.PANELARK_BACKUP_PASSPHRASE ? "可执行加密定时备份" : "更新快照可自动托管；定时备份仍需环境密钥" });
  const secretPath = path.join(dataDirectory, "panelark.secret");
  const secretValid = fs.existsSync(secretPath) && fs.statSync(secretPath).size >= 32;
  checks.push({ id: "cdk-secret", label: "CDK 密钥", status: secretValid ? "pass" : "fail", detail: secretValid ? "独立密钥文件存在且长度有效" : "CDK 密钥缺失或过短" });
  const adminCounts = db.get<DbRow>("SELECT COUNT(*) AS total, SUM(CASE WHEN totp_enabled = 1 THEN 1 ELSE 0 END) AS protected FROM admins WHERE enabled = 1");
  const total = Number(adminCounts?.total || 0); const protectedCount = Number(adminCounts?.protected || 0);
  checks.push({ id: "2fa", label: "管理员 2FA", status: total > 0 && protectedCount === total ? "pass" : protectedCount > 0 ? "warning" : "fail", detail: `${protectedCount}/${total} 个启用账号已开启 2FA` });
  const expiredSessions = db.get<DbRow>("SELECT COUNT(*) AS total FROM admin_sessions WHERE expires_at <= ?", [new Date().toISOString()]);
  checks.push({ id: "sessions", label: "会话清理", status: Number(expiredSessions?.total || 0) === 0 ? "pass" : "warning", detail: Number(expiredSessions?.total || 0) === 0 ? "没有过期会话残留" : "存在待清理的过期会话" });
  checks.push({ id: "app-auth", label: "API 外层认证", status: process.env.APP_AUTH_TOKEN ? "pass" : "warning", detail: process.env.APP_AUTH_TOKEN ? "已启用可信反向代理令牌" : "未配置，可由管理员会话与 CDK 权限保护业务接口" });
  const failed = checks.filter(check => check.status === "fail").length;
  const warnings = checks.filter(check => check.status === "warning").length;
  return { generatedAt: new Date().toISOString(), production, summary: failed ? "fail" : warnings ? "warning" : "pass", failed, warnings, checks };
}
