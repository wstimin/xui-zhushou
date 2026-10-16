import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { mountPanelArkApi } from "./panelark-api.js";
import { applicationUpdatePolicy, installationSettings, installationStatus } from "./setup.js";

test("web installation validates domain and reserves the installation entry", () => {
  assert.deepEqual(installationSettings({ siteName: "My Panel", siteUrl: "https://panel.example.com/", adminPath: "/control" }), { siteName: "My Panel", siteUrl: "https://panel.example.com", adminPath: "/control" });
  for (const siteUrl of ["javascript:alert(1)", "https://user:pass@example.com", "https://example.com/path", "https://example.com?q=secret", "https://example.com#secret"]) assert.throws(() => installationSettings({ siteUrl }));
  assert.throws(() => installationSettings({ siteUrl: "https://example.com", adminPath: "/install" }), /保留路径/);
});

test("web installation checks the actual store, saves settings atomically and locks after initialization", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panelark-web-install-"));
  const previousData = process.env.PANELARK_DATA_DIR, previousToken = process.env.PANELARK_SETUP_TOKEN;
  const previousMode = process.env.PANELARK_DEPLOYMENT_MODE;
  process.env.PANELARK_DEPLOYMENT_MODE = "panel";
  process.env.PANELARK_DATA_DIR = directory; process.env.PANELARK_SETUP_TOKEN = "Web-install-owner-token-2026";
  const app = express(); app.use(express.json());
  const services = await mountPanelArkApi(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const post = (body: unknown) => fetch(`${base}/admin/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const valid = { setupToken: process.env.PANELARK_SETUP_TOKEN, username: "owner", password: "Valid_Web!2026", installation: { siteName: "My Site", siteUrl: "https://panel.example.com", adminPath: "/private-console" } };
  try {
    const status = await (await fetch(`${base}/setup/status`)).json();
    assert.equal(status.required, true); assert.equal(status.ready, true); assert.equal(status.database, "SQLite"); assert.equal(status.checks.length, 4);
    assert.doesNotMatch(JSON.stringify(status), /Web-install-owner-token-2026/);
    assert.equal((await post({ ...valid, setupToken: "wrong" })).status, 400);
    assert.equal((await post({ ...valid, installation: { ...valid.installation, adminPath: "/install" } })).status, 400);
    assert.equal(services.db.get("SELECT COUNT(*) AS count FROM admins")?.count, 0);
    const simultaneous = await Promise.all([post(valid), post({ ...valid, username: "attacker" })]);
    assert.deepEqual(simultaneous.map(response => response.status).sort(), [200, 400]);
    assert.equal(services.db.get("SELECT COUNT(*) AS count FROM admins")?.count, 1);
    const succeeded = simultaneous.find(response => response.status === 200)!;
    const completed = await succeeded.json() as any;
    assert.equal(completed.adminPath, "/private-console"); assert.ok(completed.csrfToken); assert.match(succeeded.headers.get("set-cookie")!, /HttpOnly/);
    const config = await (await fetch(`${base}/public/config`)).json(); assert.equal(config.siteName, "My Site"); assert.equal(config.siteUrl, "https://panel.example.com");
    assert.equal((await (await fetch(`${base}/setup/status`)).json()).required, false);
    assert.equal((await post(valid)).status, 400);
    assert.equal(installationStatus(services.db, directory).required, false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve())); services.db.close(); fs.rmSync(directory, { recursive: true, force: true });
    if (previousData === undefined) delete process.env.PANELARK_DATA_DIR; else process.env.PANELARK_DATA_DIR = previousData;
    if (previousToken === undefined) delete process.env.PANELARK_SETUP_TOKEN; else process.env.PANELARK_SETUP_TOKEN = previousToken;
    if (previousMode === undefined) delete process.env.PANELARK_DEPLOYMENT_MODE; else process.env.PANELARK_DEPLOYMENT_MODE = previousMode;
  }
});

test("panel and Docker deployments use their external process manager for application updates", () => {
  const previous = process.env.PANELARK_DEPLOYMENT_MODE;
  try {
    for (const mode of ["panel", "docker"]) { process.env.PANELARK_DEPLOYMENT_MODE = mode; assert.equal(applicationUpdatePolicy().applicationUpdateSupported, false); assert.match(applicationUpdatePolicy().applicationUpdateHint, /面板/); }
    delete process.env.PANELARK_DEPLOYMENT_MODE; assert.equal(applicationUpdatePolicy().applicationUpdateSupported, true);
  } finally { if (previous === undefined) delete process.env.PANELARK_DEPLOYMENT_MODE; else process.env.PANELARK_DEPLOYMENT_MODE = previous; }
});
