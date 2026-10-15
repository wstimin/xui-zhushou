import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { PanelArkDatabase } from "./panelark-db.js";
import { PanelArkJobEngine, verifyHttp, verifyPort, verifyService, verifyVersion } from "./panelark-jobs.js";
import { mountPanelArkApi } from "./panelark-api.js";
import { issueTestCdk } from "./test-cdk.js";

async function openDatabase(prefix: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = await PanelArkDatabase.open(path.join(directory, "panelark.sqlite"));
  return { db, directory };
}

const steps = [
  { key: "preflight", title: "前置检查" },
  { key: "execute", title: "执行任务" },
  { key: "verify", title: "验证结果" },
];

test("persistent job engine stores steps/events and redacts secrets", async () => {
  const { db, directory } = await openDatabase("panelark-stage4-logs-");
  try {
    const engine = new PanelArkJobEngine(db);
    const job = engine.createJob({
      kind: "panel-deployment", serverKey: "203.0.113.10:22", grantHash: "grant-hash", taskKey: "task-1",
      idempotencyKey: "idem-1", payload: { password: "super-secret", host: "203.0.113.10" }, steps,
    });
    const observed: string[] = [];
    const unsubscribe = engine.subscribe(job.id, event => observed.push(event.type));
    const finished = await engine.startJob(job.id, async context => {
      await context.step("preflight", async () => { context.log("password=super-secret"); context.progress(25, "前置检查完成"); });
      await context.step("execute", async () => { context.progress(60, "执行中"); });
      await context.step("verify", async () => { context.progress(100, "验证完成"); });
      return { accessUrl: "https://example.test", apiToken: "should-not-be-stored" };
    });
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.progress, 100);
    assert.equal(finished.payload.password, "[redacted]");
    assert.equal((finished.result as { apiToken?: unknown })?.apiToken, "[redacted]");
    const rawEvents = db.all<{ message: string; payload_json: string }>("SELECT message, payload_json FROM deployment_events WHERE job_id = ?", [job.id]);
    assert.ok(rawEvents.length >= 7);
    assert.ok(rawEvents.every(event => !event.message.includes("super-secret") && !event.payload_json.includes("super-secret")));
    assert.ok(engine.getEvents(job.id, 1).every(event => event.sequence > 1));
    unsubscribe();
    assert.ok(observed.includes("queued") && observed.includes("started") && observed.includes("succeeded"));
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("same-server lock, cancellation and safe retry are enforced", async () => {
  const { db, directory } = await openDatabase("panelark-stage4-lock-");
  try {
    const engine = new PanelArkJobEngine(db);
    const first = engine.createJob({ kind: "panel", serverKey: "198.51.100.20:22", steps, timeoutMs: 30_000 });
    const second = engine.createJob({ kind: "panel", serverKey: "198.51.100.20:22", steps, timeoutMs: 30_000 });
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const firstRun = engine.startJob(first.id, async context => { await context.step("preflight", async () => hold); });
    assert.throws(() => engine.startJob(second.id, async () => undefined), /已有任务正在执行/);
    engine.cancelJob(first.id);
    release();
    const cancelled = await firstRun;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(engine.getJob(first.id)?.status, "cancelled");

    const retryable = engine.createJob({ kind: "retryable", serverKey: "198.51.100.21:22", steps, maxAttempts: 2 });
    const failed = await engine.startJob(retryable.id, async () => { throw new Error("temporary failure"); });
    assert.equal(failed.status, "failed");
    const queued = engine.retryJob(retryable.id);
    assert.equal(queued.status, "queued");
    const recovered = await engine.startJob(retryable.id, async context => {
      await context.step("preflight", async () => undefined);
      return { ok: true };
    });
    assert.equal(recovered.status, "succeeded");
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("backend restart marks running jobs for manual recovery", async () => {
  const { db, directory } = await openDatabase("panelark-stage4-recovery-");
  try {
    const engine = new PanelArkJobEngine(db);
    const job = engine.createJob({ kind: "panel", serverKey: "192.0.2.40:22", steps });
    db.run("UPDATE deployment_jobs SET status = 'running' WHERE id = ?", [job.id]);
    db.run("INSERT INTO deployment_locks(server_key, job_id, acquired_at) VALUES (?, ?, ?)", [job.serverKey, job.id, new Date().toISOString()]);
    const recoveredEngine = new PanelArkJobEngine(db);
    const recovered = recoveredEngine.getJob(job.id)!;
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.recoveryStatus, "manual");
    assert.equal(db.get("SELECT job_id FROM deployment_locks WHERE server_key = ?", [job.serverKey]), undefined);
    assert.ok(recoveredEngine.getEvents(job.id).some(event => event.type === "recovery"));
    void engine;
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("generic service, port, HTTP and version verification helpers reject unsafe results", async () => {
  const run = async (command: string) => command.startsWith("systemctl")
    ? { code: 0, stdout: "active\n", stderr: "" }
    : { code: 0, stdout: "LISTEN 0 128 0.0.0.0:8080\n", stderr: "" };
  assert.equal(await verifyService(run, "x-ui"), true);
  assert.equal(await verifyPort(run, 8080), true);
  assert.equal(await verifyHttp(async () => ({ status: 200 }), "https://example.test/health"), true);
  assert.equal(verifyVersion("3.6.0", "3.6"), true);
  await assert.rejects(() => verifyService(run, "x-ui; reboot"), /不安全/);
  await assert.rejects(() => verifyHttp(async () => ({ status: 503 }), "https://example.test/health"), /503/);
  assert.throws(() => verifyVersion("2.0.0", "3.6"), /版本验证失败/);
});

test("job HTTP API requires a registered adapter and supports idempotency and cancellation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "panelark-stage4-api-"));
  const previousDataDirectory = process.env.PANELARK_DATA_DIR;
  const previousSetupToken = process.env.PANELARK_SETUP_TOKEN;
  process.env.PANELARK_DATA_DIR = directory;
  process.env.PANELARK_SETUP_TOKEN = "stage-four-api-token";
  const app = express();
  app.use(express.json());
  const services = await mountPanelArkApi(app);
  const testCdk = issueTestCdk(services.db, directory, "PAK-TEST-JOBS-2026");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api`;
  const json = async (response: Response) => response.json() as Promise<Record<string, any>>;
  try {
    const grant = await json(await fetch(`${base}/cdk/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: testCdk }) }));
    assert.ok(grant.grantToken);
    const lock = await fetch(`${base}/cdk/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, taskKey: "stage4-api-task" }) });
    assert.equal(lock.status, 200);
    const missingAdapter = await fetch(`${base}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, taskKey: "stage4-api-task", serverKey: "203.0.113.99:22" }) });
    assert.equal(missingAdapter.status, 409);
    const body = { grantToken: grant.grantToken, taskKey: "stage4-api-task", kind: "tool", serverKey: "203.0.113.99:22", idempotencyKey: "stage4-idem", adapterId: "docker", operation: "install", payload: { panelPassword: "hidden" } };
    const created = await json(await fetch(`${base}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    assert.equal(created.job.status, "queued");
    const repeated = await json(await fetch(`${base}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    assert.equal(repeated.job.id, created.job.id);
    assert.equal(repeated.job.payload.panelPassword, "[redacted]");
    const fetched = await json(await fetch(`${base}/jobs/${created.job.id}?grantToken=${encodeURIComponent(grant.grantToken)}`));
    assert.equal(fetched.job.id, created.job.id);
    assert.equal(fetched.job.status, "queued");
    const secondBody = { ...body, idempotencyKey: "stage4-cancel", taskKey: "stage4-api-cancel" };
    await fetch(`${base}/cdk/release`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant.grantToken, taskKey: "stage4-api-task" }) });
    const grant2 = await json(await fetch(`${base}/cdk/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: testCdk }) }));
    await fetch(`${base}/cdk/lock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant2.grantToken, taskKey: secondBody.taskKey }) });
    secondBody.grantToken = grant2.grantToken;
    const second = await json(await fetch(`${base}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(secondBody) }));
    const cancelled = await json(await fetch(`${base}/jobs/${second.job.id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grantToken: grant2.grantToken, taskKey: secondBody.taskKey }) }));
    assert.equal(cancelled.job.status, "cancelled");
    const events = services.jobEngine.getEvents(created.job.id);
    assert.ok(events.some(event => event.type === "queued"));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    services.db.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (previousDataDirectory === undefined) delete process.env.PANELARK_DATA_DIR; else process.env.PANELARK_DATA_DIR = previousDataDirectory;
    if (previousSetupToken === undefined) delete process.env.PANELARK_SETUP_TOKEN; else process.env.PANELARK_SETUP_TOKEN = previousSetupToken;
  }
});
