import assert from "node:assert/strict";
import test from "node:test";
import { createThreeXUiAdapter, getPanelAdapter, listPanelAdapters } from "./panel-adapters.js";

function context(payload: Record<string, any>) {
  const events: string[] = [];
  const state = { events, progress: 0 };
  return {
    ...state,
    payload,
    jobId: "test-job",
    signal: new AbortController().signal,
    attempt: 1,
    async step<T>(_key: string, task: () => Promise<T>) { return task(); },
    log(message: string) { events.push(message); },
    progress(value: number) { state.progress = value; },
    residue() {},
    checkCancelled() {},
  } as any;
}

test("3x-ui adapter exposes explicit capabilities, requirements and independent operations", () => {
  const adapter = getPanelAdapter("3x-ui");
  assert.ok(adapter);
  assert.deepEqual(adapter.metadata.operations, ["install", "create-node", "get-tls"]);
  assert.equal(adapter.metadata.requirements.systemd, true);
  assert.ok(adapter.metadata.capabilities.includes("reality"));
  assert.ok(adapter.metadata.steps.install.some(step => step.key === "verify"));
  assert.ok(listPanelAdapters().some(item => item.id === "3x-ui"));
});

test("3x-ui install adapter performs service and credential verification", async () => {
  const calls: string[] = [];
  const fakeClient = {
    async authenticate() { calls.push("authenticate"); },
    async getApiToken() { calls.push("token"); return "api-token"; },
    async close() { calls.push("close"); },
  } as any;
  const adapter = createThreeXUiAdapter({
    connect: async () => ({ client: { end() {} } as any, host: "198.51.100.10", port: 22, user: "root", fingerprint: "SHA256:test", latencyMs: 5, alive: true }) as any,
    inspect: async () => ({ targetHost: "198.51.100.10", osName: "Ubuntu", arch: "x86_64", status: "compatible", isRoot: true }) as any,
    exec: async (_client, command) => {
      calls.push(command.includes("systemctl is-active") ? "verify" : "install");
      return command.includes("systemctl is-active")
        ? { stdout: "active\n__XUI_PANEL_PORT__=2053\n__XUI_WEB_BASE_PATH__=xui\n__XUI_ACCESS_URL__=https://198.51.100.10:2053/xui\n", stderr: "", code: 0 }
        : { stdout: "installed", stderr: "", code: 0 };
    },
    client: () => fakeClient,
    sleep: async () => undefined,
  });
  const result = await adapter.execute("install", context({ ipOrDomain: "198.51.100.10", sshUser: "root", sshPassword: "secret", scriptType: "official" }) as any) as any;
  assert.equal(result.adapterId, "3x-ui");
  assert.equal(result.accessUrl, "https://198.51.100.10:2053/xui");
  assert.equal(result.apiToken, "api-token");
  assert.deepEqual(calls, ["install", "verify", "authenticate", "token", "close"]);
});

test("3x-ui node creation is a separate operation and rolls back a failed route", async () => {
  let deleted = 0;
  let updated = 0;
  const fakeClient = {
    async getRealityKeyPair() { return { privateKey: "private", publicKey: "public" }; },
    async addInbound() { return { id: 17, tag: "inbound-test" }; },
    async getXrayTemplate() { return { xraySetting: { outbounds: [] }, outboundTestUrl: "" }; },
    async updateXrayTemplate() { updated += 1; throw new Error("route update failed"); },
    async restartXray() {},
    async listInbounds() { return [{ id: 17, tag: "inbound-test", protocol: "vless", port: 24443 }]; },
    async deleteInbound() { deleted += 1; },
    async close() {},
  } as any;
  const adapter = createThreeXUiAdapter({ client: () => fakeClient });
  await assert.rejects(
    adapter.execute("create-node", context({
      panelAddress: "198.51.100.20", panelPort: 2053, panelPath: "/xui", panelToken: "token", panelUser: "admin", panelPass: "password",
      protocol: "VLESS", transport: "TCP", security: "Reality", port: 24443, nodeName: "test-node", sni: "example.com",
      socksRawInput: "socks5://user:pass@127.0.0.1:1080", autoOutbound: true, autoRouting: true,
    }) as any), /route update failed/,
  );
  assert.equal(updated, 2);
  assert.equal(deleted, 1);
});
