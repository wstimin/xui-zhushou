import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backupPassphraseForRecord, backupPreview, createBackupArchive, decryptBackup, managedBackupPassphrase } from "./panelark-backup.js";
import { PanelArkDatabase } from "./panelark-db.js";
import { generateTotpSecret, totpCode, verifyTotp } from "./panelark-security.js";

test("TOTP accepts the active time window and rejects invalid codes", () => {
  const secret = generateTotpSecret();
  const timestamp = Date.UTC(2026, 9, 15, 12, 0, 0);
  const code = totpCode(secret, timestamp);
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyTotp(code, secret, timestamp), true);
  assert.equal(verifyTotp("00000x", secret, timestamp), false);
});

test("encrypted .pgbak round-trips core data and rejects a wrong password", async () => {
  const previousAppVersion = process.env.APP_VERSION;
  process.env.APP_VERSION = "2.1.9-acceptance";
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panelark-backup-"));
  fs.writeFileSync(path.join(directory, "panelark.secret"), Buffer.alloc(32, 7));
  const db = await PanelArkDatabase.open(path.join(directory, "panelark.sqlite"));
  try {
    db.run("INSERT OR REPLACE INTO site_settings(key, value, updated_at) VALUES ('site_notice', 'backup-test', ?)", [new Date().toISOString()]);
    const archive = createBackupArchive(db, directory, "Backup-Pass!2026");
    const shortArchive = createBackupArchive(db, directory, "123456");
    assert.equal(decryptBackup(shortArchive, "123456").product, "PanelArk");
    assert.throws(() => createBackupArchive(db, directory, "12345"), /6 至 256 位/);
    assert.equal(archive.subarray(0, 8).toString("ascii"), "PGBK0001");
    assert.equal(archive.includes(Buffer.from("backup-test")), false);
    assert.throws(() => decryptBackup(archive, "Wrong-Pass!!2026"), /密码错误|损坏/);
    const preview = backupPreview(archive, "Backup-Pass!2026");
    assert.equal(preview.product, "PanelArk");
    assert.equal(preview.appVersion, "2.1.9-acceptance");
    assert.ok(preview.excludes.includes("SSH 私钥"));
    const payload = decryptBackup(archive, "Backup-Pass!2026");
    db.run("UPDATE site_settings SET value = 'changed' WHERE key = 'site_notice'");
    db.replaceFromBytes(Buffer.from(payload.database, "base64"));
    assert.equal(db.get("SELECT value FROM site_settings WHERE key = 'site_notice'")?.value, "backup-test");
  } finally {
    if (previousAppVersion === undefined) delete process.env.APP_VERSION; else process.env.APP_VERSION = previousAppVersion;
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("pre-update backups use a persistent local managed key without asking the administrator", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panelark-managed-backup-"));
  fs.writeFileSync(path.join(directory, "panelark.secret"), Buffer.alloc(32, 9));
  const db = await PanelArkDatabase.open(path.join(directory, "panelark.sqlite"));
  try {
    const first = managedBackupPassphrase(directory);
    const second = backupPassphraseForRecord(directory, "managed_pre_update", "");
    assert.equal(first, second); assert.ok(first.length >= 32);
    assert.equal(backupPassphraseForRecord(directory, "manual", "123456"), "123456");
    assert.equal(backupPassphraseForRecord(directory, "pre_update", "legacy-password"), "legacy-password");
    assert.equal(decryptBackup(createBackupArchive(db, directory, first), second).product, "PanelArk");
    assert.equal(fs.statSync(path.join(directory, "backup-managed.key")).isFile(), true);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
