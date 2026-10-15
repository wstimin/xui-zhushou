import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import ssh2 from "ssh2";
import { mountPanelArkApi } from "./panelark-api.js";
import { issueTestCdk } from "./test-cdk.js";

const { Server: SshServer } = ssh2;

function commandOutput(command: string) {
  if (command.includes("__OS__")) return [
    "__OS__=Ubuntu 24.04 LTS", "__OS_ID__=ubuntu", "__OS_VERSION__=24.04", "__ARCH__=x86_64",
    "__SYSTEMD_ACTIVE__=yes", "__RAM_KB__=4194304", "__FREE_KB__=3145728", "__DISK_FREE_KB__=52428800",
    "__UID__=0", "__CURL__=yes", "__PKG_MANAGER__=apt",
  ].join("\n");
  if (command.includes("__DEP_CURL__")) return [
    "__DEP_CURL__=yes", "__DEP_CA_CERTIFICATES__=yes", "__DEP_TAR__=yes", "__DEP_GZIP__=yes",
    "__DEP_UNZIP__=yes", "__DEP_OPENSSL__=yes", "__DEP_SOCAT__=yes", "__DEP_IPROUTE2__=yes", "__DOCKER__=no", "__DOCKER_COMPOSE__=no", "__DOCKER_VERSION__=",
    "__FIREWALL__=none", "__FIREWALL_ACTIVE__=no", "__FIREWALL_SUMMARY__=none",
  ].join("\n");
  if (command.includes("__DOCKER__")) return "__DOCKER__=yes\n__DOCKER_COMPOSE__=yes\n__DOCKER_VERSION__=Docker version 27.0.0";
  if (command.includes("__FIREWALL__")) return "__FIREWALL__=none\n__FIREWALL_ACTIVE__=no\n__FIREWALL_SUMMARY__=none";
  if (command.includes("__PORT__")) {
    const ports = command.match(/for p in ([0-9 ]+);/)?.[1].trim().split(/\s+/) || [];
    return ports.map(port => port === "80"
      ? '__PORT__=80|LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1286,fd=6))'
      : `__PORT__=${port}|`).join("\n");
  }
  return "";
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, any>>;
}

test("PanelArk remote API confirms fingerprints and controls only observed services", async () => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "panelark-stage3-"));
  const previousDataDirectory = process.env.PANELARK_DATA_DIR;
  const previousSetupToken = process.env.PANELARK_SETUP_TOKEN;
  process.env.PANELARK_DATA_DIR = dataDirectory;
  process.env.PANELARK_SETUP_TOKEN = "unused-stage-three-setup";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  const ssh = new SshServer({ hostKeys: [privateKey] }, client => {
    client.on("authentication", context => {
      if (context.method === "password" && context.username === "root" && context.password === "secret") context.accept();
      else context.reject();
    });
    client.on("ready", () => client.on("session", accept => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        const stream = acceptExec();
        stream.write(commandOutput(info.command));
        stream.exit(0);
        stream.end();
      });
    }));
  });
  ssh.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { ssh.once("listening", resolve); ssh.once("error", reject); });
  const sshAddress = ssh.address();
  assert.ok(sshAddress && typeof sshAddress === "object");

  const app = express();
  app.use(express.json());
  const services = await mountPanelArkApi(app);
  const testCdk = issueTestCdk(services.db, dataDirectory, "PAK-TEST-REMOTE-2026");
  const http = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { http.once("listening", resolve); http.once("error", reject); });
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api`;

  try {
    const grant = await json(await fetch(`${base}/cdk/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: testCdk }) }));
    assert.ok(grant.grantToken);
    const connected = await json(await fetch(`${base}/server/connect`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ grantToken: grant.grantToken, connection: { ipOrDomain: "127.0.0.1", sshPort: sshAddress.port, sshUser: "root", authType: "password", sshPassword: "secret" } }),
    }));
    assert.match(connected.fingerprint, /^SHA256:/);

    const wrongFingerprint = await fetch(`${base}/server/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, serverSessionId: connected.serverSessionId, fingerprint: "SHA256:wrong" }) });
    assert.equal(wrongFingerprint.status, 400);

    const inspected = await json(await fetch(`${base}/server/inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, serverSessionId: connected.serverSessionId, fingerprint: connected.fingerprint }) }));
    assert.equal(inspected.details.compatibility.compatible, true);
    assert.equal(inspected.details.missingDependencies.length, 0);
    assert.equal(inspected.details.freeRamMb, 3072);
    assert.equal(inspected.details.docker.installed, false);

    const unconfirmedDocker = await fetch(`${base}/server/docker/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, serverSessionId: connected.serverSessionId }) });
    assert.equal(unconfirmedDocker.status, 400);
    const docker = await json(await fetch(`${base}/server/docker/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, serverSessionId: connected.serverSessionId, confirmed: true }) }));
    assert.equal(docker.docker.composeInstalled, true);

    const ports = await json(await fetch(`${base}/server/ports/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, serverSessionId: connected.serverSessionId, ports: [80, 443] }) }));
    assert.equal(ports.items[0].service, "nginx");
    assert.equal(ports.items[1].occupied, false);

    const rejectedStop = await fetch(`${base}/server/service/temporary-stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, serverSessionId: connected.serverSessionId, service: "sshd" }) });
    assert.equal(rejectedStop.status, 400);
    const stopped = await json(await fetch(`${base}/server/service/temporary-stop`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, serverSessionId: connected.serverSessionId, service: "nginx" }) }));
    assert.ok(stopped.restoreToken);
    const restored = await json(await fetch(`${base}/server/service/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, serverSessionId: connected.serverSessionId, restoreToken: stopped.restoreToken }) }));
    assert.equal(restored.restored, true);

    const firewall = await json(await fetch(`${base}/server/firewall/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, serverSessionId: connected.serverSessionId, ports: [sshAddress.port] }) }));
    assert.equal(firewall.localAction, "not_required");
    assert.equal(firewall.probes[0].reachable, true);

    const disconnected = await fetch(`${base}/server/disconnect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, serverSessionId: connected.serverSessionId }) });
    assert.equal(disconnected.status, 200);
  } finally {
    await new Promise<void>(resolve => http.close(() => resolve()));
    await new Promise<void>(resolve => ssh.close(() => resolve()));
    services.db.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
    if (previousDataDirectory === undefined) delete process.env.PANELARK_DATA_DIR; else process.env.PANELARK_DATA_DIR = previousDataDirectory;
    if (previousSetupToken === undefined) delete process.env.PANELARK_SETUP_TOKEN; else process.env.PANELARK_SETUP_TOKEN = previousSetupToken;
  }
});
