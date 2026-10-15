import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { PanelArkDatabase } from "./panelark-db.js";
import { buildSecurityReport } from "./panelark-security-audit.js";
import { canonicalManifest, compareVersions, PanelArkUpdateManager, ReleaseManifest, validateAdapterCatalog, validateReleaseManifest } from "./panelark-update.js";

function signedManifest(): { manifest: ReleaseManifest; publicKey: string } {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const unsigned: Omit<ReleaseManifest, "signature"> = {
    schemaVersion: 1, product: "PanelArk", version: "2.1.0", channel: "stable",
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
