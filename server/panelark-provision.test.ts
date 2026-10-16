import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { initializeInstallation, readInstallationInfo, resetAdministratorPassword } from "./panelark-provision.js";
import { validatePassword, verifyPassword } from "./panelark-security.js";
import { PanelArkDatabase } from "./panelark-db.js";
import { mountPanelArkApi } from "./panelark-api.js";

test("administrator passwords accept six characters without composition restrictions", () => {
  for (const value of ["123456", "abcdef", "密码密码密码", "a".repeat(128)]) assert.equal(validatePassword(value), value);
  for (const value of ["", "12345", "a".repeat(129)]) assert.throws(() => validatePassword(value), /6 至 128/);
});

test("terminal initialization is persistent, never overwrites accounts and info never rewrites the live database", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panelark-provision-"));
  try {
    const input = { username: "owner", password: "123456", siteName: "Terminal site", siteUrl: "https://panel.example.com", adminPath: "/private-console" };
    assert.equal((await readInstallationInfo(directory)).initialized, false);
    assert.equal((await initializeInstallation(directory, input)).created, true);
    const file = path.join(directory, "panelark.sqlite"), before = fs.readFileSync(file), stat = fs.statSync(file);
    const info = await readInstallationInfo(directory);
    assert.equal(info.username, "owner"); assert.equal(info.adminPath, "/private-console"); assert.equal(info.siteUrl, "https://panel.example.com");
    assert.doesNotMatch(JSON.stringify(info), /123456|scrypt/);
    assert.deepEqual(fs.readFileSync(file), before); assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
    assert.equal((await initializeInstallation(directory, { ...input, username: "attacker" })).created, false);
    assert.equal((await readInstallationInfo(directory)).username, "owner");
    await resetAdministratorPassword(directory, { username: "owner", password: "abcdef" });
    const db = await PanelArkDatabase.open(file);
    try {
      const hash = String(db.get("SELECT password_hash FROM admins WHERE username='owner'")?.password_hash);
      assert.equal(await verifyPassword("abcdef", hash), true); assert.equal(await verifyPassword("123456", hash), false);
      assert.equal(db.get("SELECT COUNT(*) AS n FROM admins")?.n, 1);
    } finally { db.close(); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("standalone deployments disable public initialization even if a setup token is supplied", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panelark-no-wizard-"));
  const saved = { data: process.env.PANELARK_DATA_DIR, mode: process.env.PANELARK_DEPLOYMENT_MODE, token: process.env.PANELARK_SETUP_TOKEN };
  process.env.PANELARK_DATA_DIR = directory; process.env.PANELARK_DEPLOYMENT_MODE = "standalone"; process.env.PANELARK_SETUP_TOKEN = "known-token";
  const app = express(); app.use(express.json()); const services = await mountPanelArkApi(app);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  try {
    const status = await (await fetch(`${base}/setup/status`)).json(); assert.equal(status.enabled, false); assert.equal(status.required, false);
    const bootstrap = await (await fetch(`${base}/admin/bootstrap`)).json(); assert.equal(bootstrap.required, false); assert.equal(bootstrap.terminalInitializationRequired, true);
    const rejected = await fetch(`${base}/admin/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken: "known-token", username: "owner", password: "123456" }) });
    assert.equal(rejected.status, 403); assert.equal(services.db.get("SELECT COUNT(*) AS n FROM admins")?.n, 0);
    assert.equal(fs.existsSync(path.join(directory, "admin-setup-token.txt")), false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); services.db.close(); fs.rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries({ PANELARK_DATA_DIR: saved.data, PANELARK_DEPLOYMENT_MODE: saved.mode, PANELARK_SETUP_TOKEN: saved.token })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
