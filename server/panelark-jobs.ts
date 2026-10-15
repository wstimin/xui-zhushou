import { randomUUID } from "node:crypto";
import { Response } from "express";
import { PanelArkDatabase, DbRow } from "./panelark-db.js";

export type JobStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted" | "manual";
export type JobStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
export type RecoveryStatus = "none" | "pending" | "manual" | "recovered";

export interface JobStepDefinition {
  key: string;
  title: string;
}

export interface CreateJobInput {
  kind: string;
  serverKey: string;
  grantHash?: string;
  taskKey?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
  steps: JobStepDefinition[];
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface DeploymentJob {
  id: string;
  kind: string;
  serverKey: string;
  status: JobStatus;
  recoveryStatus: RecoveryStatus;
  attempt: number;
  maxAttempts: number;
  timeoutMs: number;
  progress: number;
  currentStep?: string;
  payload: Record<string, unknown>;
  result?: unknown;
  errorMessage?: string;
  residue?: unknown;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  steps: Array<DeploymentStep>;
}

export interface DeploymentStep {
  id: string;
  jobId: string;
  key: string;
  title: string;
  status: JobStepStatus;
  attempt: number;
  progress: number;
  errorMessage?: string;
  residue?: unknown;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobEvent {
  id: number;
  jobId: string;
  sequence: number;
  type: string;
  stepKey?: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class JobCancellationError extends Error {
  constructor(message = "部署任务已取消") {
    super(message);
    this.name = "JobCancellationError";
  }
}

type JobExecutor = (context: JobExecutionContext) => Promise<unknown>;
type Subscriber = ((event: JobEvent) => void) & { lastSequence?: number };

export interface JobExecutionContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly attempt: number;
  step<T>(key: string, executor: () => Promise<T>): Promise<T>;
  log(message: string, payload?: Record<string, unknown>): void;
  progress(value: number, message?: string): void;
  residue(value: unknown): void;
  checkCancelled(): void;
}

const TERMINAL = new Set<JobStatus>(["succeeded", "failed", "cancelled", "timed_out", "interrupted", "manual"]);
const ACTIVE = new Set<JobStatus>(["queued", "running", "cancelling"]);
const MAX_MESSAGE = 800;

function now() { return new Date().toISOString(); }

function safeNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try { return JSON.parse(String(value || "")) as T; } catch { return fallback; }
}

function redactText(value: unknown): string {
  let text = String(value ?? "");
  text = text.replace(/(password|passwd|token|secret|private[_-]?key|authorization|cookie)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");
  text = text.replace(/https?:\/\/[^\s]+/gi, match => match.replace(/(token|secret|password|key)=[^&\s]+/gi, "$1=[redacted]"));
  return text.replace(/[\r\n]+/g, " ").slice(0, MAX_MESSAGE);
}

function redactPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/password|passwd|token|secret|private|authorization|cookie|credential/i.test(key)) result[key] = "[redacted]";
    else if (typeof item === "string") result[key] = redactText(item);
    else if (item && typeof item === "object") result[key] = redactPayload(item);
    else result[key] = item;
  }
  return result;
}

function toJob(row: DbRow, steps: DbRow[]): DeploymentJob {
  return {
    id: String(row.id),
    kind: String(row.kind),
    serverKey: String(row.server_key),
    status: String(row.status) as JobStatus,
    recoveryStatus: String(row.recovery_status) as RecoveryStatus,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    timeoutMs: Number(row.timeout_ms),
    progress: Number(row.progress),
    currentStep: row.current_step ? String(row.current_step) : undefined,
    payload: parseJson(row.payload_json, {}),
    result: row.result_json ? parseJson(row.result_json, undefined) : undefined,
    errorMessage: row.error_message ? String(row.error_message) : undefined,
    residue: row.residue_json ? parseJson(row.residue_json, undefined) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at ? String(row.started_at) : undefined,
    finishedAt: row.finished_at ? String(row.finished_at) : undefined,
    steps: steps.map(step => ({
      id: String(step.id), jobId: String(step.job_id), key: String(step.step_key), title: String(step.title),
      status: String(step.status) as JobStepStatus, attempt: Number(step.attempt), progress: Number(step.progress),
      errorMessage: step.error_message ? String(step.error_message) : undefined,
      residue: step.residue_json ? parseJson(step.residue_json, undefined) : undefined,
      startedAt: step.started_at ? String(step.started_at) : undefined,
      finishedAt: step.finished_at ? String(step.finished_at) : undefined,
    })),
  };
}

function toEvent(row: DbRow): JobEvent {
  return {
    id: Number(row.id), jobId: String(row.job_id), sequence: Number(row.sequence), type: String(row.type),
    stepKey: row.step_key ? String(row.step_key) : undefined, message: String(row.message || ""),
    payload: parseJson(row.payload_json, {}), createdAt: String(row.created_at),
  };
}

export class PanelArkJobEngine {
  private readonly executions = new Map<string, { controller: AbortController; promise: Promise<DeploymentJob>; timedOut: { value: boolean } }>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(private readonly db: PanelArkDatabase) {
    this.recoverOrphans();
  }

  recoverOrphans() {
    const orphaned = this.db.all<DbRow>("SELECT id FROM deployment_jobs WHERE status IN ('running','cancelling')");
    for (const row of orphaned) {
      const jobId = String(row.id);
      const timestamp = now();
      this.db.transaction(() => {
        this.db.run("UPDATE deployment_jobs SET status = 'interrupted', recovery_status = 'manual', error_message = ?, residue_json = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status IN ('running','cancelling')", [
          "服务进程在任务执行期间重启，任务未自动续跑",
          JSON.stringify({ reason: "backend_restart", action: "请检查目标服务器后再安全重试" }), timestamp, timestamp, jobId,
        ]);
        this.db.run("UPDATE deployment_steps SET status = CASE WHEN status = 'running' THEN 'failed' ELSE status END, error_message = CASE WHEN status = 'running' THEN ? ELSE error_message END, finished_at = CASE WHEN status = 'running' THEN ? ELSE finished_at END WHERE job_id = ?", ["后端重启中断", timestamp, jobId]);
        this.db.run("DELETE FROM deployment_locks WHERE job_id = ?", [jobId]);
        this.appendEvent(jobId, "recovery", undefined, "任务已标记为中断，需要人工检查后重试", { recoveryStatus: "manual" });
      });
      this.publishStoredEvents(jobId);
    }
    this.db.run("DELETE FROM deployment_locks WHERE job_id NOT IN (SELECT id FROM deployment_jobs WHERE status IN ('queued','running','cancelling'))");
  }

  createJob(input: CreateJobInput): DeploymentJob {
    const kind = redactText(input.kind).replace(/[^\w.-]/g, "-").slice(0, 80);
    const serverKey = redactText(input.serverKey).replace(/[^\w:.-]/g, "-").slice(0, 180);
    if (!kind || !serverKey) throw new Error("任务类型和目标服务器不能为空");
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 50) throw new Error("任务步骤数量必须在 1 到 50 之间");
    const steps = input.steps.map(step => ({ key: String(step.key || "").trim().slice(0, 80), title: redactText(step.title).slice(0, 160) }));
    if (steps.some(step => !step.key || !step.title) || new Set(steps.map(step => step.key)).size !== steps.length) throw new Error("任务步骤标识无效或重复");
    const idempotencyKey = input.idempotencyKey ? redactText(input.idempotencyKey).slice(0, 180) : undefined;
    if (idempotencyKey) {
      const existing = this.db.get<DbRow>("SELECT id FROM deployment_jobs WHERE idempotency_key = ?", [idempotencyKey]);
      if (existing) return this.getJob(String(existing.id))!;
    }
    const jobId = randomUUID();
    const timestamp = now();
    const timeoutMs = safeNumber(input.timeoutMs, 20 * 60_000, 5_000, 2 * 60 * 60_000);
    const maxAttempts = safeNumber(input.maxAttempts, 1, 1, 3);
    this.db.transaction(() => {
      this.db.run("INSERT INTO deployment_jobs(id, kind, server_key, grant_hash, task_key, idempotency_key, status, recovery_status, attempt, max_attempts, timeout_ms, progress, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'none', 0, ?, ?, 0, ?, ?, ?)", [
        jobId, kind, serverKey, input.grantHash || null, input.taskKey || null, idempotencyKey || null, maxAttempts, timeoutMs, JSON.stringify(redactPayload(input.payload || {})), timestamp, timestamp,
      ]);
      for (const step of steps) this.db.run("INSERT INTO deployment_steps(id, job_id, step_key, title, status) VALUES (?, ?, ?, ?, 'pending')", [randomUUID(), jobId, step.key, step.title]);
      this.appendEvent(jobId, "queued", undefined, "任务已进入持久化队列", { kind, serverKey });
    });
    this.publishStoredEvents(jobId);
    return this.getJob(jobId)!;
  }

  getJob(jobId: string): DeploymentJob | undefined {
    const row = this.db.get<DbRow>("SELECT * FROM deployment_jobs WHERE id = ?", [jobId]);
    if (!row) return undefined;
    return toJob(row, this.db.all<DbRow>("SELECT * FROM deployment_steps WHERE job_id = ? ORDER BY id", [jobId]));
  }

  getJobForGrant(jobId: string, grantHash: string): DeploymentJob | undefined {
    const row = this.db.get<DbRow>("SELECT * FROM deployment_jobs WHERE id = ? AND grant_hash = ?", [jobId, grantHash]);
    if (!row) return undefined;
    return toJob(row, this.db.all<DbRow>("SELECT * FROM deployment_steps WHERE job_id = ? ORDER BY id", [jobId]));
  }

  listJobs(limit = 100) {
    return this.db.all<DbRow>("SELECT * FROM deployment_jobs ORDER BY created_at DESC LIMIT ?", [safeNumber(limit, 100, 1, 500)]).map(row => toJob(row, this.db.all<DbRow>("SELECT * FROM deployment_steps WHERE job_id = ? ORDER BY id", [row.id])));
  }

  getEvents(jobId: string, afterSequence = 0) {
    return this.db.all<DbRow>("SELECT * FROM deployment_events WHERE job_id = ? AND sequence > ? ORDER BY sequence", [jobId, Math.max(0, Number(afterSequence) || 0)]).map(toEvent);
  }

  subscribe(jobId: string, subscriber: Subscriber, afterSequence = 0) {
    const subscribers = this.subscribers.get(jobId) || new Set<Subscriber>();
    this.subscribers.set(jobId, subscribers);
    let last = Math.max(0, Number(afterSequence) || 0);
    const wrapped = ((event: JobEvent) => { if (event.sequence > last) { last = event.sequence; subscriber(event); } }) as Subscriber;
    wrapped.lastSequence = last;
    subscribers.add(wrapped);
    for (const event of this.getEvents(jobId, last)) { last = event.sequence; subscriber(event); }
    wrapped.lastSequence = last;
    return () => {
      const current = this.subscribers.get(jobId);
      if (!current) return;
      current.delete(wrapped);
      if (!current.size) this.subscribers.delete(jobId);
    };
  }

  startJob(jobId: string, executor: JobExecutor): Promise<DeploymentJob> {
    const current = this.executions.get(jobId);
    if (current) return current.promise;
    const job = this.getJob(jobId);
    if (!job) throw new Error("部署任务不存在");
    if (job.status !== "queued") throw new Error(`当前任务状态为 ${job.status}，不能启动`);
    const timestamp = now();
    this.db.transaction(() => {
      const lock = this.db.get("SELECT job_id FROM deployment_locks WHERE server_key = ?", [job.serverKey]);
      if (lock) throw new Error("目标服务器已有任务正在执行，请等待当前任务结束");
      this.db.run("INSERT INTO deployment_locks(server_key, job_id, acquired_at) VALUES (?, ?, ?)", [job.serverKey, job.id, timestamp]);
      this.db.run("UPDATE deployment_jobs SET status = 'running', attempt = attempt + 1, recovery_status = 'none', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'", [timestamp, timestamp, job.id]);
      this.appendEvent(job.id, "started", undefined, "任务开始执行", { attempt: job.attempt + 1 });
    });
    this.publishStoredEvents(job.id);
    const controller = new AbortController();
    const timedOut = { value: false };
    const timer = setTimeout(() => {
      timedOut.value = true;
      this.requestCancel(job.id, "任务超过执行时限，已请求安全取消", "timed_out");
      controller.abort(new JobCancellationError("任务执行超时"));
    }, job.timeoutMs);
    timer.unref?.();
    const promise = this.execute(job.id, executor, controller, timedOut).finally(() => clearTimeout(timer));
    this.executions.set(job.id, { controller, promise, timedOut });
    return promise;
  }

  cancelJob(jobId: string) {
    const job = this.getJob(jobId);
    if (!job) throw new Error("部署任务不存在");
    if (TERMINAL.has(job.status)) return job;
    this.requestCancel(jobId, "收到取消请求，任务将安全停止并执行恢复流程", "cancelled");
    this.executions.get(jobId)?.controller.abort(new JobCancellationError());
    return this.getJob(jobId)!;
  }

  retryJob(jobId: string) {
    const job = this.getJob(jobId);
    if (!job) throw new Error("部署任务不存在");
    if (!["failed", "cancelled", "timed_out", "interrupted", "manual"].includes(job.status)) throw new Error("当前任务状态不能重试");
    if (job.attempt >= job.maxAttempts) throw new Error("任务已达到最大安全重试次数");
    if (this.db.get("SELECT job_id FROM deployment_locks WHERE server_key = ?", [job.serverKey])) throw new Error("目标服务器已有任务正在执行");
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run("UPDATE deployment_jobs SET status = 'queued', recovery_status = 'pending', progress = 0, current_step = NULL, error_message = NULL, residue_json = NULL, result_json = NULL, updated_at = ?, finished_at = NULL WHERE id = ?", [timestamp, jobId]);
      this.db.run("UPDATE deployment_steps SET status = 'pending', progress = 0, error_message = NULL, residue_json = NULL, started_at = NULL, finished_at = NULL WHERE job_id = ?", [jobId]);
      this.appendEvent(jobId, "retry_queued", undefined, "任务已重新排队，等待安全重试", { attempt: job.attempt + 1 });
    });
    this.publishStoredEvents(jobId);
    return this.getJob(jobId)!;
  }

  private requestCancel(jobId: string, message: string, terminal: "cancelled" | "timed_out") {
    const job = this.getJob(jobId);
    if (!job || TERMINAL.has(job.status)) return;
    const timestamp = now();
    this.db.transaction(() => {
      if (job.status === "queued") {
        this.db.run("UPDATE deployment_jobs SET status = ?, error_message = ?, updated_at = ?, finished_at = ? WHERE id = ?", [terminal, redactText(message), timestamp, timestamp, jobId]);
        this.db.run("DELETE FROM deployment_locks WHERE job_id = ?", [jobId]);
      } else {
        this.db.run("UPDATE deployment_jobs SET status = 'cancelling', error_message = ?, updated_at = ? WHERE id = ? AND status IN ('running','cancelling')", [redactText(message), timestamp, jobId]);
      }
      this.appendEvent(jobId, "cancel_requested", undefined, message, { terminal });
    });
    this.publishStoredEvents(jobId);
  }

  private async execute(jobId: string, executor: JobExecutor, controller: AbortController, timedOut: { value: boolean }) {
    const job = this.getJob(jobId)!;
    const residue: unknown[] = [];
    const context: JobExecutionContext = {
      jobId, signal: controller.signal, attempt: job.attempt + 1,
      step: async <T>(key: string, task: () => Promise<T>) => {
        const current = this.getJob(jobId);
        const step = current?.steps.find(item => item.key === key);
        if (!step) throw new Error(`未知任务步骤：${key}`);
        context.checkCancelled();
        const timestamp = now();
        this.db.run("UPDATE deployment_jobs SET current_step = ?, updated_at = ? WHERE id = ?", [key, timestamp, jobId]);
        this.db.run("UPDATE deployment_steps SET status = 'running', attempt = attempt + 1, started_at = ?, finished_at = NULL, error_message = NULL, progress = 0 WHERE job_id = ? AND step_key = ?", [timestamp, jobId, key]);
        this.emit(jobId, "step_started", key, step.title, { attempt: step.attempt + 1 });
        try {
          const result = await task();
          context.checkCancelled();
          this.db.run("UPDATE deployment_steps SET status = 'succeeded', progress = 100, finished_at = ? WHERE job_id = ? AND step_key = ?", [now(), jobId, key]);
          this.emit(jobId, "step_succeeded", key, `${step.title}完成`, {});
          return result;
        } catch (error) {
          const message = redactText(error instanceof Error ? error.message : error);
          this.db.run("UPDATE deployment_steps SET status = ?, error_message = ?, finished_at = ? WHERE job_id = ? AND step_key = ?", [controller.signal.aborted ? "cancelled" : "failed", message, now(), jobId, key]);
          this.emit(jobId, controller.signal.aborted ? "step_cancelled" : "step_failed", key, message, {});
          throw error;
        }
      },
      log: (message, payload = {}) => this.emit(jobId, "log", undefined, message, payload),
      progress: (value, message) => {
        const progress = safeNumber(value, 0, 0, 100);
        this.db.run("UPDATE deployment_jobs SET progress = ?, updated_at = ? WHERE id = ?", [progress, now(), jobId]);
        if (message) this.emit(jobId, "progress", undefined, message, { progress });
      },
      residue: value => { residue.push(redactPayload(value)); this.db.run("UPDATE deployment_jobs SET residue_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(residue), now(), jobId]); },
      checkCancelled: () => { if (controller.signal.aborted) throw new JobCancellationError(); },
    };
    try {
      const result = await executor(context);
      context.checkCancelled();
      return this.finish(jobId, "succeeded", undefined, result, residue);
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof JobCancellationError;
      const status: JobStatus = timedOut.value ? "timed_out" : cancelled ? "cancelled" : "failed";
      const message = redactText(error instanceof Error ? error.message : error);
      return this.finish(jobId, status, message, undefined, residue);
    } finally {
      this.executions.delete(jobId);
    }
  }

  private finish(jobId: string, status: JobStatus, errorMessage: string | undefined, result: unknown, residue: unknown[]) {
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run("UPDATE deployment_jobs SET status = ?, recovery_status = ?, progress = ?, result_json = ?, error_message = ?, residue_json = ?, updated_at = ?, finished_at = ? WHERE id = ?", [
        status, status === "succeeded" ? "recovered" : residue.length ? "manual" : "none", status === "succeeded" ? 100 : Number(this.getJob(jobId)?.progress || 0), result === undefined ? null : JSON.stringify(redactPayload(result)), errorMessage || null, residue.length ? JSON.stringify(residue) : null, timestamp, timestamp, jobId,
      ]);
      this.db.run("UPDATE deployment_steps SET status = 'cancelled', finished_at = ? WHERE job_id = ? AND status IN ('pending','running') AND ? IN ('cancelled','timed_out')", [timestamp, jobId, status]);
      this.db.run("DELETE FROM deployment_locks WHERE job_id = ?", [jobId]);
      this.appendEvent(jobId, status, undefined, status === "succeeded" ? "任务完成" : errorMessage || "任务未完成", { status, residue: residue.length > 0 });
    });
    this.publishStoredEvents(jobId);
    return this.getJob(jobId)!;
  }

  private emit(jobId: string, type: string, stepKey: string | undefined, message: string, payload: Record<string, unknown>) {
    this.appendEvent(jobId, type, stepKey, redactText(message), redactPayload(payload));
    this.publishStoredEvents(jobId);
  }

  private appendEvent(jobId: string, type: string, stepKey: string | undefined, message: string, payload: Record<string, unknown>) {
    const latest = this.db.get<DbRow>("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM deployment_events WHERE job_id = ?", [jobId]);
    this.db.run("INSERT INTO deployment_events(job_id, sequence, type, step_key, message, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [jobId, Number(latest?.sequence || 0) + 1, type, stepKey || null, redactText(message), JSON.stringify(redactPayload(payload)), now()]);
  }

  private publishStoredEvents(jobId: string) {
    const subscribers = this.subscribers.get(jobId);
    if (!subscribers?.size) return;
    const events = this.getEvents(jobId, 0);
    for (const subscriber of subscribers) {
      const last = subscriber.lastSequence || 0;
      for (const event of events) {
        if (event.sequence > last) {
          subscriber.lastSequence = event.sequence;
          subscriber(event);
        }
      }
    }
  }
}

export function attachJobSse(engine: PanelArkJobEngine, jobId: string, req: { header(name: string): string | undefined; query?: Record<string, unknown> }, res: Response) {
  const lastEventId = Number(req.header("last-event-id") || req.query?.after || 0) || 0;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const write = (event: JobEvent) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    (res as Response & { flush?: () => void }).flush?.();
  };
  const unsubscribe = engine.subscribe(jobId, write, lastEventId);
  const heartbeat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(`: heartbeat ${Date.now()}\n\n`); }, 15_000);
  heartbeat.unref?.();
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  res.on("close", cleanup);
  return cleanup;
}

export async function verifyService(run: (command: string) => Promise<{ code: number; stdout: string; stderr: string }>, service: string) {
  if (!/^[a-zA-Z0-9_.@-]{1,80}$/.test(service)) throw new Error("服务名称不安全");
  const result = await run(`systemctl is-active ${service}`);
  if (result.code !== 0 || result.stdout.trim() !== "active") throw new Error(`服务 ${service} 未处于 active 状态`);
  return true;
}

export async function verifyPort(run: (command: string) => Promise<{ code: number; stdout: string; stderr: string }>, port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口无效");
  const result = await run(`ss -ltnH '( sport = :${port} )'`);
  if (result.code !== 0 || !result.stdout.trim()) throw new Error(`端口 ${port} 未监听`);
  return true;
}

export async function verifyHttp(fetcher: (url: string) => Promise<{ status: number }>, url: string, expectedStatus = 200) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("HTTP 验证地址必须使用 HTTP 或 HTTPS");
  const response = await fetcher(parsed.toString());
  if (response.status !== expectedStatus) throw new Error(`HTTP 健康检查返回 ${response.status}`);
  return true;
}

export function verifyVersion(actual: string, expectedPrefix: string) {
  const safeActual = String(actual || "").trim();
  const safeExpected = String(expectedPrefix || "").trim();
  if (!safeActual || !safeExpected || !safeActual.startsWith(safeExpected)) throw new Error(`版本验证失败：当前 ${safeActual || "未知"}，期望 ${safeExpected || "未知"}`);
  return true;
}
