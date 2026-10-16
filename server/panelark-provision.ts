import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import initSqlJs from "sql.js";
import { PanelArkDatabase } from "./panelark-db.js";
import { normalizeUsername, validatePassword, hashPassword, loadOrCreatePepper } from "./panelark-security.js";
import { installationRequired, installationSettings } from "./setup.js";
import { normalizeAdminPath } from "./admin-path.js";

// Information is read from a snapshot, never migrated/persisted over a live server.
export async function readInstallationInfo(dataDirectory: string) {
  const file = path.join(dataDirectory, "panelark.sqlite");
  if (!fs.existsSync(file)) return { initialized: false, username: "", adminPath: "/admin", siteName: "PanelArk 面板方舟", siteUrl: "" };
  const SQL = await initSqlJs({ locateFile: () => path.resolve("node_modules/sql.js/dist/sql-wasm.wasm") });
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    const query = (sql: string) => { const s = db.prepare(sql); try { return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } };
    const admin = query("SELECT username FROM admins WHERE role = 'super_admin' AND enabled = 1 ORDER BY created_at LIMIT 1");
    const values: Record<string, string> = {};
    const settings = db.prepare("SELECT key, value FROM site_settings WHERE key IN ('admin_path','site_name','site_url')");
    try { while (settings.step()) { const row = settings.getAsObject(); values[String(row.key)] = String(row.value); } } finally { settings.free(); }
    return { initialized: Boolean(query("SELECT id FROM admins LIMIT 1")), username: String(admin?.username || ""), adminPath: normalizeAdminPath(values.admin_path || "/admin"), siteName: values.site_name || "PanelArk 面板方舟", siteUrl: values.site_url || "" };
  } finally { db.close(); }
}

// Caller stops the only PM2 writer before opening the writable database.
export async function initializeInstallation(dataDirectory: string, input: Record<string, unknown>) {
  const username = normalizeUsername(input.username), password = validatePassword(input.password);
  const settings = installationSettings(input);
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  loadOrCreatePepper(dataDirectory);
  const db = await PanelArkDatabase.open(path.join(dataDirectory, "panelark.sqlite"));
  try {
    if (!installationRequired(db)) return { created: false };
    const passwordHash = await hashPassword(password), timestamp = new Date().toISOString();
    db.transaction(() => {
      if (!installationRequired(db)) throw new Error("管理员已存在，禁止重复初始化");
      db.run("INSERT INTO admins(id, username, password_hash, role, created_at, updated_at, password_changed_at) VALUES (?, ?, ?, 'super_admin', ?, ?, ?)", [randomUUID(), username, passwordHash, timestamp, timestamp, timestamp]);
      for (const [key, value] of Object.entries({ site_name: settings.siteName, site_url: settings.siteUrl, admin_path: settings.adminPath, installation_completed_at: timestamp })) {
        db.run("INSERT OR REPLACE INTO site_settings(key, value, updated_at) VALUES (?, ?, ?)", [key, value, timestamp]);
      }
      db.run("DELETE FROM site_settings WHERE key = 'admin_setup_token_hash'");
    });
    fs.rmSync(path.join(dataDirectory, "admin-setup-token.txt"), { force: true });
    return { created: true, username, ...settings };
  } finally { db.close(); }
}

export async function resetAdministratorPassword(dataDirectory: string, input: Record<string, unknown>) {
  const username = normalizeUsername(input.username), password = validatePassword(input.password);
  const db = await PanelArkDatabase.open(path.join(dataDirectory, "panelark.sqlite"));
  try {
    const admin = db.get("SELECT id FROM admins WHERE username = ? AND role = 'super_admin' AND enabled = 1", [username]);
    if (!admin) throw new Error("未找到启用的超级管理员，未修改任何账号");
    const hash = await hashPassword(password), now = new Date().toISOString();
    db.transaction(() => {
      db.run("UPDATE admins SET password_hash = ?, updated_at = ?, password_changed_at = ? WHERE id = ?", [hash, now, now, String(admin.id)]);
      db.run("DELETE FROM admin_sessions WHERE admin_id = ?", [String(admin.id)]);
    });
    return { updated: true, username };
  } finally { db.close(); }
}
