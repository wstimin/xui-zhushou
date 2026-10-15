import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { mountPanelArkApi } from "./panelark-api.js";
import { totpCode } from "./panelark-security.js";

async function json(response: Response) {
  return response.json() as Promise<Record<string, any>>;
}

test("PanelArk admin and CDK lifecycle is persistent, guarded and idempotent", async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "panelark-stage2-"));
  const previousDataDirectory = process.env.PANELARK_DATA_DIR;
  const previousSetupToken = process.env.PANELARK_SETUP_TOKEN;
  process.env.PANELARK_DATA_DIR = dataDirectory;
  process.env.PANELARK_SETUP_TOKEN = "stage-two-setup-token";

  const app = express();
  app.use(express.json());
  const services = await mountPanelArkApi(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api`;

  try {
    assert.equal(Number(services.db.get<{ total: number }>("SELECT COUNT(*) AS total FROM cdks")?.total || 0), 0);
    const adapters = await json(await fetch(`${base}/adapters`));
    assert.ok(adapters.items.length >= 16);
    assert.ok(adapters.items.some((item: { id: string; capabilities: string[] }) => item.id === "3x-ui" && item.capabilities.includes("reality")));
    assert.ok(adapters.items.some((item: { id: string; kind: string }) => item.id === "docker" && item.kind === "tool"));
    const bootstrapState = await json(await fetch(`${base}/admin/bootstrap`));
    assert.equal(bootstrapState.required, true);

    const rejectedBootstrap = await fetch(`${base}/admin/bootstrap`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: "wrong", username: "owner", password: "Secure_Admin!2026" }),
    });
    assert.equal(rejectedBootstrap.status, 400);

    const bootstrapResponse = await fetch(`${base}/admin/bootstrap`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: "stage-two-setup-token", username: "owner", password: "Secure_Admin!2026" }),
    });
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = await json(bootstrapResponse);
    const cookie = bootstrapResponse.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    assert.ok(bootstrap.csrfToken);

    const noCsrf = await fetch(`${base}/admin/packages`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    assert.equal(noCsrf.status, 403);

    const adminHeaders = { cookie, "content-type": "application/json", "x-csrf-token": String(bootstrap.csrfToken) };
    const updateStatus = await json(await fetch(`${base}/admin/update/status`, { headers: adminHeaders }));
    assert.equal(updateStatus.state.phase, "idle");
    const securityReport = await json(await fetch(`${base}/admin/security/report`, { headers: adminHeaders }));
    assert.ok(securityReport.report.checks.some((item: { id: string }) => item.id === "cdk-secret"));
    const packageResponse = await json(await fetch(`${base}/admin/packages`, {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ name: "单次测试套餐", maxUses: 1, validityDays: 30 }),
    }));
    assert.ok(packageResponse.id);

    const batch = await json(await fetch(`${base}/admin/batches`, {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ packageId: packageResponse.id, name: "自动测试批次", quantity: 1 }),
    }));
    assert.equal(batch.codes.length, 1);
    const code = batch.codes[0];

    const grantA = await json(await fetch(`${base}/cdk/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }));
    const grantB = await json(await fetch(`${base}/cdk/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }));
    assert.ok(grantA.grantToken && grantB.grantToken);

    const lockA = await fetch(`${base}/cdk/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grantA.grantToken, taskKey: "task-a" }) });
    assert.equal(lockA.status, 200);
    const lockBWhileBusy = await fetch(`${base}/cdk/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grantB.grantToken, taskKey: "task-b" }) });
    assert.equal(lockBWhileBusy.status, 409);

    const releaseA = await fetch(`${base}/cdk/release`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grantA.grantToken, taskKey: "task-a" }) });
    assert.equal(releaseA.status, 200);
    const lockB = await fetch(`${base}/cdk/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grantB.grantToken, taskKey: "task-b" }) });
    assert.equal(lockB.status, 200);

    const consumeBody = JSON.stringify({ grantToken: grantB.grantToken, taskKey: "task-b" });
    const consume = await json(await fetch(`${base}/cdk/consume`, { method: "POST", headers: { "content-type": "application/json" }, body: consumeBody }));
    const consumeAgain = await json(await fetch(`${base}/cdk/consume`, { method: "POST", headers: { "content-type": "application/json" }, body: consumeBody }));
    assert.equal(consume.alreadyConsumed, false);
    assert.equal(consumeAgain.alreadyConsumed, true);

    const exhausted = await fetch(`${base}/cdk/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    assert.equal(exhausted.status, 400);

    const unsafeSettings = await fetch(`${base}/admin/settings`, {
      method: "PUT", headers: adminHeaders, body: JSON.stringify({ purchaseEnabled: true, purchaseUrl: "http://unsafe.example" }),
    });
    assert.equal(unsafeSettings.status, 400);
    const safeSettings = await json(await fetch(`${base}/admin/settings`, {
      method: "PUT", headers: adminHeaders, body: JSON.stringify({ purchaseEnabled: true, purchaseButtonText: "立即购买", purchaseUrl: "https://shop.example/cdk", adminPath: "/private-console" }),
    }));
    assert.equal(safeSettings.purchaseUrl, "https://shop.example/cdk");
    assert.equal(safeSettings.adminPath, "/private-console");

    const resource = await json(await fetch(`${base}/admin/resources`, {
      method: "POST", headers: adminHeaders,
      body: JSON.stringify({ type: "vps", title: "测试 VPS", url: "https://vps.example.test", enabled: true, sortOrder: 1 }),
    }));
    assert.ok(resource.id);
    const publicResources = await json(await fetch(`${base}/resources`));
    assert.equal(publicResources.items[0].title, "测试 VPS");
    const click = await json(await fetch(`${base}/resources/${resource.id}/click`, { method: "POST" }));
    assert.equal(click.url, "https://vps.example.test");

    const disableDocker = await fetch(`${base}/admin/catalog/docker`, {
      method: "PUT", headers: adminHeaders, body: JSON.stringify({ enabled: false, sortOrder: 1 }),
    });
    assert.equal(disableDocker.status, 200);
    const adaptersAfterDisable = await json(await fetch(`${base}/adapters`));
    assert.equal(adaptersAfterDisable.items.some((item: { id: string }) => item.id === "docker"), false);
    await fetch(`${base}/admin/catalog/docker`, { method: "PUT", headers: adminHeaders, body: JSON.stringify({ enabled: true, sortOrder: 1 }) });

    const backup = await json(await fetch(`${base}/admin/backups`, {
      method: "POST", headers: adminHeaders, body: JSON.stringify({ passphrase: "Backup_Pass!2026", reason: "manual" }),
    }));
    assert.match(backup.item.filename, /\.pgbak$/);
    const backupPreview = await json(await fetch(`${base}/admin/backups/${backup.item.id}/preview`, {
      method: "POST", headers: adminHeaders, body: JSON.stringify({ passphrase: "Backup_Pass!2026" }),
    }));
    assert.equal(backupPreview.preview.product, "PanelArk");

    const twoFactorSetup = await json(await fetch(`${base}/admin/2fa/setup`, {
      method: "POST", headers: adminHeaders, body: JSON.stringify({ currentPassword: "Secure_Admin!2026" }),
    }));
    assert.ok(twoFactorSetup.secret);
    const twoFactorEnable = await fetch(`${base}/admin/2fa/enable`, {
      method: "POST", headers: adminHeaders, body: JSON.stringify({ code: totpCode(twoFactorSetup.secret) }),
    });
    assert.equal(twoFactorEnable.status, 200);

    const accountUpdate = await fetch(`${base}/admin/account`, {
      method: "PUT", headers: adminHeaders,
      body: JSON.stringify({ currentPassword: "Secure_Admin!2026", username: "panelark_owner", newPassword: "New_Secure!2026" }),
    });
    assert.equal(accountUpdate.status, 200);
    const login = await fetch(`${base}/admin/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "panelark_owner", password: "New_Secure!2026", totpCode: totpCode(twoFactorSetup.secret) }),
    });
    assert.equal(login.status, 200);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    services.db.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
    if (previousDataDirectory === undefined) delete process.env.PANELARK_DATA_DIR; else process.env.PANELARK_DATA_DIR = previousDataDirectory;
    if (previousSetupToken === undefined) delete process.env.PANELARK_SETUP_TOKEN; else process.env.PANELARK_SETUP_TOKEN = previousSetupToken;
  }
});
