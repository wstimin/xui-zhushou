import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { randomUUID } from "node:crypto";
import { PanelArkDatabase } from "./panelark-db.js";

const MAGIC = Buffer.from("PGBK0001", "ascii");
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

type BackupReason = "manual" | "scheduled" | "pre_update" | "pre_restore" | "uploaded";

export type BackupPayload = {
  format: 1;
  product: "PanelArk";
  createdAt: string;
  appVersion: string;
  database: string;
  cdkPepper: string;
};

function validatePassphrase(passphrase: unknown) {
  const value = String(passphrase || "");
  if (value.length < 12 || value.length > 256) throw new Error("备份密码需为 12 至 256 位");
  return value;
}

export function encryptBackup(payload: BackupPayload, passphrase: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(validatePassphrase(passphrase), salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, iv, tag, encrypted]);
}

export function decryptBackup(archive: Uint8Array, passphrase: string): BackupPayload {
  const bytes = Buffer.from(archive);
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("备份文件超过 25MB 限制");
  if (bytes.length < 53 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("不是有效的 PanelArk .pgbak 文件");
  const salt = bytes.subarray(8, 24);
  const iv = bytes.subarray(24, 36);
  const tag = bytes.subarray(36, 52);
  const encrypted = bytes.subarray(52);
  try {
    const key = scryptSync(validatePassphrase(passphrase), salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    const payload = JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8")) as BackupPayload;
    if (payload.format !== 1 || payload.product !== "PanelArk" || !payload.database || !payload.cdkPepper) throw new Error("备份内容不完整");
    const database = Buffer.from(payload.database, "base64");
    if (!database.subarray(0, 16).toString("utf8").startsWith("SQLite format 3")) throw new Error("备份数据库格式无效");
    return payload;
  } catch (error) {
    if (error instanceof Error && (error.message.includes("备份") || error.message.includes("密码"))) throw error;
    throw new Error("备份密码错误或文件已损坏");
  }
}

export function backupPreview(archive: Uint8Array, passphrase: string) {
  const payload = decryptBackup(archive, passphrase);
  return {
    product: payload.product,
    format: payload.format,
    createdAt: payload.createdAt,
    appVersion: payload.appVersion,
    databaseBytes: Buffer.byteLength(payload.database, "base64"),
    includes: ["业务数据库", "CDK 哈希密钥"],
    excludes: ["SSH 密码", "SSH 私钥", "临时 SSH 会话"],
  };
}

export function createBackupArchive(db: PanelArkDatabase, dataDirectory: string, passphrase: string) {
  const secretPath = path.join(dataDirectory, "panelark.secret");
  if (!fs.existsSync(secretPath)) throw new Error("CDK 密钥不存在，不能创建可迁移备份");
  const versionFile = path.join(process.cwd(), "VERSION");
  const appVersion = process.env.APP_VERSION || process.env.npm_package_version
    || (fs.existsSync(versionFile) ? fs.readFileSync(versionFile, "utf8").trim() : JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).version);
  return encryptBackup({
    format: 1,
    product: "PanelArk",
    createdAt: new Date().toISOString(),
    appVersion,
    database: db.exportBytes().toString("base64"),
    cdkPepper: fs.readFileSync(secretPath).toString("base64"),
  }, passphrase);
}

export function saveBackup(db: PanelArkDatabase, dataDirectory: string, passphrase: string, reason: BackupReason, createdBy?: string) {
  const archive = createBackupArchive(db, dataDirectory, passphrase);
  const backupDirectory = path.join(dataDirectory, "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const id = randomUUID();
  const filename = `panelark-${new Date().toISOString().replace(/[:.]/g, "-")}-${reason}.pgbak`;
  fs.writeFileSync(path.join(backupDirectory, filename), archive, { mode: 0o600 });
  db.run(
    "INSERT INTO backup_records(id, filename, reason, size_bytes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, filename, reason, archive.length, createdBy || null, new Date().toISOString()],
  );
  return { id, filename, reason, sizeBytes: archive.length, archive };
}

export function backupFilePath(dataDirectory: string, filename: string) {
  const safeName = path.basename(filename);
  if (!safeName.endsWith(".pgbak") || safeName !== filename) throw new Error("备份文件名无效");
  return path.join(dataDirectory, "backups", safeName);
}

export function isBackupArchive(value: Uint8Array) {
  const bytes = Buffer.from(value);
  return bytes.length >= MAGIC.length && bytes.subarray(0, MAGIC.length).equals(MAGIC);
}

export const backupLimits = { maxArchiveBytes: MAX_ARCHIVE_BYTES };
