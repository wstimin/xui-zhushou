import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { PanelArkDatabase } from "./panelark-db.js";
import { buildSecurityReport } from "./panelark-security-audit.js";
import { canonicalManifest, compareVersions, PanelArkUpdateManager, ReleaseManifest, validateAdapterCatalog, validateReleaseManifest } from "./panelark-update.js";

function signedManifest(version = "2.1.0"): { manifest: ReleaseManifest; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const unsigned: Omit<ReleaseManifest, "signature"> = {
    schemaVersion: 1, product: "PanelArk", version, channel: "stable",
    publishedAt: "2026-10-15T00:00:00.000Z", minVersion: "2.0.0",
    packageUrl: "https://example.test/panelark.tar.gz", sha256: "a".repeat(64),
    notes: ["signed release"], adapterCatalog: { version: "2.1.0", url: "https://example.test/adapters.json", sha256: "b".repeat(64) },
  };
  const signature = sign(null, Buffer.from(canonicalManifest(unsigned)), pair.privateKey).toString("base64");
  return { manifest: { ...unsigned, signature }, publicKey };
}

test("signed release manifest rejects tampering and insecure sources", () => {
  const { manifest, publicKey } = signedManifest();
  assert.equal(validateReleaseManifest(manifest, publicKey, "stable").version, "2.1.0");
  assert.throws(() => validateReleaseManifest({ ...manifest, version: "9.9.9" }, publicKey, "stable"), /签名/);
  assert.throws(() => validateReleaseManifest({ ...manifest, packageUrl: "http://example.test/release.tgz" }, publicKey, "stable"), /HTTPS/);
  assert.equal(compareVersions("2.1.0", "2.0.9"), 1);
  assert.equal(compareVersions("2.0.2", "2.0.2"), 0);
});

test("adapter catalog accepts only bounded declarative metadata", () => {
  const catalog = validateAdapterCatalog({ schemaVersion: 1, product: "PanelArk-Adapters", version: "2.1.0", entries: [{ id: "3x-ui", enabled: false, sortOrder: 1 }] });
  assert.equal(catalog.entries[0].id, "3x-ui");
  assert.throws(() => validateAdapterCatalog({ ...catalog, entries: [{ id: "../../evil" }] }), /无效标识/);
});

test("update state and security report survive independently of the release directory", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panelark-update-"));
  fs.writeFileSync(path.join(directory, "panelark.secret"), Buffer.alloc(32, 8));
  const db = await PanelArkDatabase.open(path.join(directory, "panelark.sqlite"));
  try {
    const { publicKey } = signedManifest();
    const manager = new PanelArkUpdateManager(db, directory, publicKey);
    assert.equal(manager.status().phase, "idle");
    fs.writeFileSync(path.join(directory, "update-state.json"), JSON.stringify({ phase: "restarting", progress: 86, currentVersion: "2.0.2", targetVersion: "2.1.0", channel: "stable", message: "restarting", updatedAt: new Date().toISOString(), events: [] }));
    const afterRestart = new PanelArkUpdateManager(db, directory, publicKey);
    assert.equal(afterRestart.status().phase, "restarting");
    assert.equal(afterRestart.status().progress, 86);
    const report = buildSecurityReport(db, directory, true);
    assert.equal(report.checks.find(check => check.id === "updates")?.status, "pass");
    assert.equal(report.checks.find(check => check.id === "cdk-secret")?.status, "pass");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("detecting a newer signed release only reads metadata; no backup, package download or application occurs", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panelark-check-only-"));
  const db = await PanelArkDatabase.open(path.join(directory, "panelark.sqlite"));
  const previousFetch = globalThis.fetch;
  const { manifest, publicKey } = signedManifest("99.0.0");
  const requests: string[] = [];
  try {
    globalThis.fetch = async url => { requests.push(String(url)); return new Response(JSON.stringify(manifest)); };
    const manager = new PanelArkUpdateManager(db, directory, publicKey);
    const before = fs.readdirSync(directory);
    const result = await manager.check("stable");
    assert.equal(result.phase, "available"); assert.equal(result.targetVersion, "99.0.0");
    assert.equal(result.preUpdateBackup, undefined);
    assert.deepEqual(fs.readdirSync(directory).filter(name => name !== "update-state.json"), before);
    assert.equal(db.get<{ total: number }>("SELECT COUNT(*) AS total FROM backup_records")?.total, 0);
    assert.equal(requests.length, 1); assert.ok(requests[0].endsWith("release-manifest.json"));
    assert.notEqual(requests[0], manifest.packageUrl);
    assert.equal((await manager.check("stable")).phase, "available");
    assert.equal(requests.length, 2);
    const stateFile = path.join(directory, "update-state.json");
    const applying = { ...manager.status(), phase: "applying" };
    fs.writeFileSync(stateFile, JSON.stringify(applying));
    await assert.rejects(manager.check("stable"), /正在进行/);
    assert.equal(manager.status().phase, "applying"); assert.equal(requests.length, 2);
  } finally { globalThis.fetch = previousFetch; db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("preparing an update creates a managed backup without a user password", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panelark-update-prepare-"));
  fs.writeFileSync(path.join(directory, "panelark.secret"), Buffer.alloc(32, 6));
  const db = await PanelArkDatabase.open(path.join(directory, "panelark.sqlite"));
  const previousFetch = globalThis.fetch;
  const archive = Buffer.from("signed-release-archive");
  const { manifest, publicKey } = signedManifest("99.0.0");
  manifest.sha256 = createHash("sha256").update(archive).digest("hex");
  const state = { phase: "available", progress: 15, currentVersion: "2.2.7", targetVersion: manifest.version, channel: "stable", message: "available", updatedAt: new Date().toISOString(), manifest, events: [] };
  fs.writeFileSync(path.join(directory, "update-state.json"), JSON.stringify(state));
  try {
    globalThis.fetch = async () => new Response(archive, { headers: { "content-length": String(archive.length) } });
    const prepared = await new PanelArkUpdateManager(db, directory, publicKey).prepare("admin");
    assert.equal(prepared.phase, "prepared"); assert.equal(prepared.progress, 50);
    assert.ok(fs.existsSync(String(prepared.archivePath)));
    assert.ok(fs.existsSync(path.join(directory, "backup-managed.key")));
    const backup = db.get<{ reason: string; filename: string }>("SELECT reason, filename FROM backup_records ORDER BY created_at DESC LIMIT 1");
    assert.equal(backup?.reason, "managed_pre_update"); assert.equal(backup?.filename, prepared.preUpdateBackup);
  } finally { globalThis.fetch = previousFetch; db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
