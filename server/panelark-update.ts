import fs from "node:fs";
import path from "node:path";
import { createHash, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { saveBackup } from "./panelark-backup.js";
import { PanelArkDatabase } from "./panelark-db.js";
import { applicationUpdatePolicy } from "./setup.js";

export type UpdateChannel = "stable" | "beta";
export type UpdatePhase = "idle" | "checking" | "available" | "current" | "downloading" | "prepared" | "applying" | "restarting" | "completed" | "rolled_back" | "failed";

export interface AdapterCatalogUpdate {
  version: string;
  url: string;
  sha256: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  product: "PanelArk";
  version: string;
  channel: UpdateChannel;
  publishedAt: string;
  minVersion: string;
  packageUrl: string;
  sha256: string;
  notes: string[];
  adapterCatalog?: AdapterCatalogUpdate;
  signature: string;
}

export interface AdapterCatalogManifest {
  schemaVersion: 1;
  product: "PanelArk-Adapters";
  version: string;
  entries: Array<{ id: string; name?: string; description?: string; category?: string; enabled?: boolean; sortOrder?: number }>;
}

export interface UpdateState {
  phase: UpdatePhase;
  progress: number;
  currentVersion: string;
  targetVersion?: string;
  channel: UpdateChannel;
  message: string;
  checkedAt?: string;
  updatedAt: string;
  manifest?: ReleaseManifest;
  archivePath?: string;
  preUpdateBackup?: string;
  error?: string;
  events: Array<{ phase: UpdatePhase; progress: number; message: string; at: string }>;
}

const MAX_PACKAGE_BYTES = 250 * 1024 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function now() { return new Date().toISOString(); }
function currentVersion() {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  const versionFile = path.join(process.cwd(), "VERSION");
  if (fs.existsSync(versionFile)) return fs.readFileSync(versionFile, "utf8").trim();
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version || "development"; } catch { return "development"; }
}

export function canonicalManifest(manifest: Omit<ReleaseManifest, "signature"> | ReleaseManifest) {
  const { signature: _signature, ...unsigned } = manifest as ReleaseManifest;
  return JSON.stringify(unsigned);
}

export function compareVersions(left: string, right: string) {
  const parse = (value: string) => value.replace(/^v/, "").split("-")[0].split(".").map(part => Number(part));
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0) ? 1 : -1;
  }
  return 0;
}

function assertHttps(value: string, label: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error(`${label}必须使用 HTTPS`);
  return parsed.toString();
}

export function validateReleaseManifest(value: unknown, publicKey: string, expectedChannel?: UpdateChannel) {
  const manifest = value as ReleaseManifest;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.product !== "PanelArk") throw new Error("更新清单格式无效");
  if (!VERSION_PATTERN.test(manifest.version) || !VERSION_PATTERN.test(manifest.minVersion)) throw new Error("更新清单版本格式无效");
  if (!(["stable", "beta"] as string[]).includes(manifest.channel) || (expectedChannel && manifest.channel !== expectedChannel)) throw new Error("更新清单通道不匹配");
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) throw new Error("更新包 SHA-256 格式无效");
  assertHttps(manifest.packageUrl, "更新包地址");
  if (manifest.adapterCatalog) {
    assertHttps(manifest.adapterCatalog.url, "适配器目录地址");
    if (!/^[a-f0-9]{64}$/i.test(manifest.adapterCatalog.sha256)) throw new Error("适配器目录 SHA-256 格式无效");
  }
  const signature = Buffer.from(String(manifest.signature || ""), "base64");
  if (!signature.length || !verify(null, Buffer.from(canonicalManifest(manifest)), publicKey, signature)) throw new Error("更新清单签名验证失败");
  return manifest;
}

export function validateAdapterCatalog(value: unknown) {
  const catalog = value as AdapterCatalogManifest;
  if (!catalog || catalog.schemaVersion !== 1 || catalog.product !== "PanelArk-Adapters" || !VERSION_PATTERN.test(catalog.version) || !Array.isArray(catalog.entries)) throw new Error("适配器目录格式无效");
  for (const entry of catalog.entries) {
    if (!entry || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.id)) throw new Error("适配器目录包含无效标识");
    if (entry.sortOrder !== undefined && (!Number.isFinite(entry.sortOrder) || entry.sortOrder < 0 || entry.sortOrder > 10_000)) throw new Error("适配器排序值无效");
  }
  return catalog;
}

function digest(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }

export class PanelArkUpdateManager {
  private readonly statePath: string;
  private readonly updateDirectory: string;

  constructor(private readonly db: PanelArkDatabase, private readonly dataDirectory: string, private readonly publicKey: string) {
    this.statePath = path.join(dataDirectory, "update-state.json");
    this.updateDirectory = path.join(dataDirectory, "updates");
  }

  status(): UpdateState {
    if (fs.existsSync(this.statePath)) {
      try { return JSON.parse(fs.readFileSync(this.statePath, "utf8")) as UpdateState; } catch { /* reset corrupt state */ }
    }
    const version = currentVersion();
    return { phase: "idle", progress: 0, currentVersion: version, channel: "stable", message: "尚未检查更新", updatedAt: now(), events: [] };
  }

  private write(patch: Partial<UpdateState>, event = true) {
    const previous = this.status();
    const next: UpdateState = { ...previous, ...patch, updatedAt: now(), events: previous.events.slice(-99) };
    if (event) next.events.push({ phase: next.phase, progress: next.progress, message: next.message, at: next.updatedAt });
    fs.mkdirSync(this.dataDirectory, { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.statePath);
    return next;
  }

  private manifestUrl(channel: UpdateChannel) {
    const configured = channel === "beta" ? process.env.PANELARK_BETA_MANIFEST_URL : process.env.PANELARK_UPDATE_MANIFEST_URL;
    return assertHttps(configured || (channel === "beta"
      ? "https://github.com/wstimin/xui-zhushou/releases/download/beta/release-manifest.json"
      : "https://github.com/wstimin/xui-zhushou/releases/latest/download/release-manifest.json"), "更新清单地址");
  }

  async check(channel: UpdateChannel) {
    if (!this.publicKey.trim()) throw new Error("未配置更新签名公钥，在线更新已安全禁用");
    const version = currentVersion();
    this.write({ phase: "checking", progress: 5, currentVersion: version, channel, message: `正在检查${channel === "stable" ? "稳定" : "测试"}通道` });
    try {
      const response = await fetch(this.manifestUrl(channel), { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`更新清单请求失败（HTTP ${response.status}）`);
      const manifest = validateReleaseManifest(await response.json(), this.publicKey, channel);
      if (compareVersions(version, manifest.minVersion) < 0) throw new Error(`当前版本低于更新所需最低版本 ${manifest.minVersion}`);
      const available = compareVersions(manifest.version, version) > 0;
      return this.write({ phase: available ? "available" : "current", progress: 15, targetVersion: manifest.version, manifest, checkedAt: now(), message: available ? `发现新版本 v${manifest.version}` : "当前已经是最新版本", error: undefined });
    } catch (error) {
      this.write({ phase: "failed", progress: 0, message: "更新检查失败", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async prepare(passphrase: string, adminId: string) {
    if (!applicationUpdatePolicy().applicationUpdateSupported) throw new Error(applicationUpdatePolicy().applicationUpdateHint);
    const state = this.status();
    if (state.phase !== "available" || !state.manifest) throw new Error("请先检查并确认存在可用更新");
    this.write({ phase: "downloading", progress: 25, message: "正在创建更新前加密备份" });
    try {
      const backup = saveBackup(this.db, this.dataDirectory, passphrase, "pre_update", adminId);
      this.write({ phase: "downloading", progress: 35, preUpdateBackup: backup.filename, message: "更新前备份完成，正在下载签名更新包" });
      const response = await fetch(state.manifest.packageUrl, { signal: AbortSignal.timeout(120_000), headers: { accept: "application/gzip, application/octet-stream" } });
      if (!response.ok) throw new Error(`更新包下载失败（HTTP ${response.status}）`);
      const declaredSize = Number(response.headers.get("content-length") || 0);
      if (declaredSize > MAX_PACKAGE_BYTES) throw new Error("更新包超过 250MB 限制");
      const archive = Buffer.from(await response.arrayBuffer());
      if (!archive.length || archive.length > MAX_PACKAGE_BYTES) throw new Error("更新包大小无效");
      if (digest(archive) !== state.manifest.sha256.toLowerCase()) throw new Error("更新包 SHA-256 校验失败");
      fs.mkdirSync(this.updateDirectory, { recursive: true });
      const archivePath = path.join(this.updateDirectory, `panelark-${state.manifest.version}.tar.gz`);
      fs.writeFileSync(archivePath, archive, { mode: 0o600 });
      return this.write({ phase: "prepared", progress: 50, archivePath, message: "更新包签名与 SHA-256 校验通过，等待应用" });
    } catch (error) {
      this.write({ phase: "failed", progress: 0, message: "更新准备失败，当前版本未发生变化", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async applyAdapterCatalog(adminId: string) {
    const state = this.status();
    const descriptor = state.manifest?.adapterCatalog;
    if (!descriptor) throw new Error("当前签名清单没有独立适配器目录更新");
    const response = await fetch(descriptor.url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`适配器目录下载失败（HTTP ${response.status}）`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== descriptor.sha256.toLowerCase()) throw new Error("适配器目录 SHA-256 校验失败");
    const catalog = validateAdapterCatalog(JSON.parse(bytes.toString("utf8")));
    const timestamp = now();
    this.db.transaction(() => {
      for (const entry of catalog.entries) {
        const existing = this.db.get<Record<string, any>>("SELECT * FROM catalog_overrides WHERE adapter_id = ?", [entry.id]);
        this.db.run(
          `INSERT OR REPLACE INTO catalog_overrides(adapter_id, name, description, category, enabled, sort_order, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [entry.id, entry.name ?? existing?.name ?? null, entry.description ?? existing?.description ?? null, entry.category ?? existing?.category ?? null, entry.enabled === undefined ? Number(existing?.enabled ?? 1) : entry.enabled ? 1 : 0, entry.sortOrder ?? Number(existing?.sort_order ?? 100), adminId, timestamp],
        );
      }
      this.db.run("INSERT OR REPLACE INTO site_settings(key, value, updated_at) VALUES ('adapter_catalog_version', ?, ?)", [catalog.version, timestamp]);
    });
    return { version: catalog.version, updated: catalog.entries.length };
  }

  apply() {
    if (!applicationUpdatePolicy().applicationUpdateSupported) throw new Error(applicationUpdatePolicy().applicationUpdateHint);
    const state = this.status();
    if (state.phase !== "prepared" || !state.archivePath || !state.targetVersion) throw new Error("没有已验证并等待应用的更新包");
    if (process.platform !== "linux" || process.env.NODE_ENV !== "production") throw new Error("在线应用更新只允许在 Linux 生产环境执行");
    const runner = path.join(process.cwd(), "scripts", "apply-update.mjs");
    if (!fs.existsSync(runner)) throw new Error("更新执行器缺失，请使用正式发布包安装");
    const next = this.write({ phase: "applying", progress: 55, message: "更新执行器已启动，服务将短暂重启" });
    // PM2 terminates application descendants during reload, even detached ones.
    // A transient system service owns the updater independently of the web app.
    const service = spawnSync("systemd-run", [
      "--quiet", "--collect", `--unit=panelark-update-${Date.now()}`,
      "--property=Type=exec", `--working-directory=${process.cwd()}`,
      "--setenv=NODE_ENV=production", `--setenv=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`,
      process.execPath, runner, "--state", this.statePath, "--target", process.cwd(),
    ], { encoding: "utf8", timeout: 15_000 });
    if (service.error || service.status !== 0) {
      const error = `无法启动独立更新服务：${service.error?.message || service.stderr || "请使用 sy install 更新"}`;
      this.write({ phase: "failed", progress: 0, message: "更新执行器未启动，当前版本未发生变化", error });
      throw new Error(error);
    }
    return next;
  }
}

export function loadUpdatePublicKey(dataDirectory: string) {
  const envKey = process.env.PANELARK_UPDATE_PUBLIC_KEY?.replace(/\\n/g, "\n").trim();
  if (envKey) return envKey;
  const candidates = [path.join(process.cwd(), "release-public-key.pem"), path.join(dataDirectory, "release-public-key.pem")];
  const file = candidates.find(candidate => fs.existsSync(candidate));
  return file ? fs.readFileSync(file, "utf8") : "";
}
