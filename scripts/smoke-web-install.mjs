import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const base = (process.argv[2] || "http://127.0.0.1:1888").replace(/\/$/, "");
if (process.argv.includes("--verify-installed")) {
  const state = await (await fetch(`${base}/api/setup/status`)).json();
  assert.equal(state.required, false); console.log("PASS installation remains locked after process/container restart");
} else {
  const token = process.env.PANELARK_SMOKE_SETUP_TOKEN;
  assert.ok(token, "PANELARK_SMOKE_SETUP_TOKEN is required for an isolated fresh test instance");
  const home = await fetch(base, { redirect: "manual" }); assert.equal(home.status, 302); assert.equal(home.headers.get("location"), "/install");
  assert.match(await (await fetch(`${base}/install`)).text(), /data-panelark-view="setup"/);
  const status = await (await fetch(`${base}/api/setup/status`)).json(); assert.equal(status.ready, true); assert.equal(status.checks.length, 4);
  console.log("PASS fresh domain entry redirects to web installer; runtime, database and storage checks pass");
  const input = { setupToken: token, username: "smoke_owner", password: `Smoke_${randomBytes(20).toString("hex")}!`, installation: { siteName: "Smoke site", siteUrl: base, adminPath: "/smoke-console" } };
  const bootstrap = body => fetch(`${base}/api/admin/bootstrap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await bootstrap({ ...input, setupToken: "wrong" })).status, 400);
  const installed = await bootstrap(input); assert.equal(installed.status, 200);
  const body = await installed.json(); const cookie = installed.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie); assert.equal(body.adminPath, "/smoke-console");
  const session = await fetch(`${base}/api/admin/session`, { headers: { cookie } }); assert.equal(session.status, 200);
  assert.match(await (await fetch(`${base}${body.adminPath}`)).text(), /data-panelark-view="admin"/);
  assert.equal((await (await fetch(`${base}/api/setup/status`)).json()).required, false);
  assert.equal((await bootstrap(input)).status, 400);
  const config = await (await fetch(`${base}/api/public/config`)).json(); assert.equal(config.siteName, "Smoke site"); assert.equal(config.siteUrl, base);
  const root = await fetch(base); assert.equal(root.status, 200); assert.doesNotMatch(await root.text(), /data-panelark-view="setup"/);
  const updateStatus = await (await fetch(`${base}/api/admin/update/status`, { headers: { cookie } })).json(); assert.equal(updateStatus.applicationUpdateSupported, false);
  const deniedUpdate = await fetch(`${base}/api/admin/update/prepare`, { method: "POST", headers: { cookie, "x-csrf-token": body.csrfToken, "content-type": "application/json" }, body: JSON.stringify({ passphrase: "Smoke_Backup!2026" }) });
  assert.equal(deniedUpdate.status, 400); assert.match((await deniedUpdate.json()).error, /面板/);
  console.log("PASS setup information persisted, admin auto-login works, reinstall is blocked and panel update policy is enforced");
}
