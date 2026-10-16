export interface PublicConfig {
  purchaseEnabled: boolean;
  purchaseButtonText: string;
  purchaseUrl: string;
  supportUrl: string;
  siteNotice: string;
}

export interface RecommendedResource {
  id: string;
  type: 'vps' | 'domain' | 'cdn' | 'other';
  title: string;
  description: string;
  badge: string;
  url: string;
  sort_order: number;
}

export interface CdkGrant {
  grantToken: string;
  packageName: string;
  remaining: number;
  expiresInMinutes: number;
}

export interface DependencyState {
  id: string;
  label: string;
  installed: boolean;
  required: boolean;
}

export interface FirewallState {
  kind: 'ufw' | 'firewalld' | 'nftables' | 'iptables' | 'none';
  active: boolean;
  summary: string;
}

export interface ServerEnvironment {
  targetHost: string;
  sshPort: number;
  sshUser: string;
  latencyMs: number;
  hostKeyFingerprint: string;
  osName: string;
  osId: string;
  osVersion: string;
  arch: string;
  kernel: string;
  systemdAvailable: boolean;
  totalRamMb: number;
  freeRamMb: number;
  diskFreeMb: number;
  cpuCores: number;
  packageManager: string;
  isRoot: boolean;
  canSudo: boolean;
  warnings: string[];
  status: 'compatible' | 'warning' | 'incompatible';
  compatibility: { compatible: boolean; reasons: string[] };
  dependencies: DependencyState[];
  missingDependencies: DependencyState[];
  docker: { installed: boolean; composeInstalled: boolean; version: string };
  firewall: FirewallState;
  fingerprintConfirmed: boolean;
}

export interface PortState {
  port: number;
  occupied: boolean;
  process: string;
  pid?: number;
  service?: string;
  raw: string;
}

export interface FirewallOpenResult {
  firewall: FirewallState;
  localAction: 'opened' | 'not_required' | 'manual_required';
  probes: Array<{ port: number; reachable: boolean }>;
  cloudSecurityGroupRequired: boolean;
  message: string;
}

export interface DeploymentJobStep {
  id: string;
  jobId: string;
  key: string;
  title: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
  attempt: number;
  progress: number;
  errorMessage?: string;
  residue?: unknown;
  startedAt?: string;
  finishedAt?: string;
}

export interface DeploymentJob {
  id: string;
  kind: string;
  serverKey: string;
  status: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted' | 'manual';
  recoveryStatus: 'none' | 'pending' | 'manual' | 'recovered';
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
  steps: DeploymentJobStep[];
}

export interface DeploymentJobEvent {
  id: number;
  jobId: string;
  sequence: number;
  type: string;
  stepKey?: string;
  message: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PanelAdapterMetadata {
  id: string;
  name: string;
  kind: 'panel' | 'tool';
  category: string;
  accent: 'gold' | 'sage' | 'blue' | 'rose' | 'violet';
  version: string;
  memory: string;
  port: string;
  description: string;
  enabled: boolean;
  supportLevel: 'verified' | 'pending';
  supportedSystems: string[];
  operations: Array<'install' | 'create-node' | 'get-tls'>;
  capabilities: string[];
  requirements: { os: string[]; minRamMb: number; minDiskMb?: number; systemd: boolean; network: boolean };
  form: Array<{ key: string; label: string; type: string; required?: boolean; secret?: boolean; options?: Array<{ label: string; value: string }> }>;
  steps: Record<'install' | 'create-node' | 'get-tls', Array<{ key: string; title: string }>>;
}

type ApiErrorBody = { error?: string };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as ApiErrorBody & T;
  if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

export const defaultPublicConfig: PublicConfig = {
  purchaseEnabled: true,
  purchaseButtonText: '购买 CDK',
  purchaseUrl: '',
  supportUrl: '',
  siteNotice: '',
};

export async function getPublicConfig() {
  return request<PublicConfig & { success: true }>('/api/public/config');
}

export async function validateCdk(code: string) {
  return request<CdkGrant & { success: true }>('/api/cdk/validate', {
    method: 'POST', body: JSON.stringify({ code }),
  });
}

export async function lockCdk(grantToken: string, taskKey: string) {
  return request<{ success: true; lockId: string; alreadyLocked: boolean }>('/api/cdk/lock', {
    method: 'POST', body: JSON.stringify({ grantToken, taskKey }),
  });
}

export async function consumeCdk(grantToken: string, taskKey: string) {
  return request<{ success: true; alreadyConsumed: boolean }>('/api/cdk/consume', {
    method: 'POST', body: JSON.stringify({ grantToken, taskKey }),
  });
}

export async function releaseCdk(grantToken: string, taskKey: string) {
  return request<{ success: true; alreadyReleased: boolean }>('/api/cdk/release', {
    method: 'POST', body: JSON.stringify({ grantToken, taskKey }),
  });
}

export async function connectServer(grantToken: string, connection: Record<string, unknown>) {
  return request<{ success: true; serverSessionId: string; host: string; port: number; user: string; fingerprint: string; latencyMs: number; expiresInMinutes: number }>('/api/server/connect', {
    method: 'POST', body: JSON.stringify({ grantToken, connection }),
  });
}

export async function inspectRemoteServer(grantToken: string, serverSessionId: string, fingerprint: string) {
  return request<{ success: true; details: ServerEnvironment }>('/api/server/inspect', {
    method: 'POST', body: JSON.stringify({ grantToken, serverSessionId, fingerprint }),
  });
}

export async function installServerDependencies(grantToken: string, serverSessionId: string, dependencyIds: string[]) {
  return request<{ success: true; dependencies: DependencyState[]; installed: string[] }>('/api/server/dependencies/install', {
    method: 'POST', body: JSON.stringify({ grantToken, serverSessionId, dependencyIds }),
  });
}

export async function installDockerRuntime(grantToken: string, serverSessionId: string) {
  return request<{ success: true; docker: ServerEnvironment['docker'] }>('/api/server/docker/install', {
    method: 'POST', body: JSON.stringify({ grantToken, serverSessionId, confirmed: true }),
  });
}

export async function checkServerPorts(grantToken: string, serverSessionId: string, ports: number[]) {
  return request<{ success: true; items: PortState[] }>('/api/server/ports/check', {
    method: 'POST', body: JSON.stringify({ grantToken, serverSessionId, ports }),
  });
}

export async function openServerFirewall(grantToken: string, serverSessionId: string, ports: number[]) {
  return request<{ success: true } & FirewallOpenResult>('/api/server/firewall/open', {
    method: 'POST', body: JSON.stringify({ grantToken, serverSessionId, ports }),
  });
}

export async function temporarilyStopService(grantToken: string, serverSessionId: string, service: string) {
  return request<{ success: true; restoreToken: string; service: string; safetyRestoreMinutes: number }>('/api/server/service/temporary-stop', {
    method: 'POST', body: JSON.stringify({ grantToken, serverSessionId, service }),
  });
}

export async function restoreService(grantToken: string, serverSessionId: string, restoreToken: string) {
  return request<{ success: true; service: string; restored: boolean }>('/api/server/service/restore', {
    method: 'POST', body: JSON.stringify({ grantToken, serverSessionId, restoreToken }),
  });
}

export async function disconnectServer(grantToken: string, serverSessionId: string) {
  return request<{ success: true }>('/api/server/disconnect', {
    method: 'POST', body: JSON.stringify({ grantToken, serverSessionId }),
  });
}

export async function createDeploymentJob(grantToken: string, taskKey: string, input: {
  kind?: string;
  serverKey: string;
  adapterId: string;
  operation: 'install' | 'create-node';
  idempotencyKey?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  payload?: Record<string, unknown>;
}) {
  return request<{ success: true; job: DeploymentJob }>('/api/jobs', {
    method: 'POST', body: JSON.stringify({ grantToken, taskKey, ...input }),
  });
}

export async function getDeploymentResult(grantToken: string, taskKey: string, jobId: string) {
  return request<{ success: true; result: Record<string, unknown>; live: boolean }>(`/api/jobs/${encodeURIComponent(jobId)}/result`, {
    method: 'POST', body: JSON.stringify({ grantToken, taskKey }),
  });
}

export async function listPanelAdapters() {
  return request<{ success: true; items: PanelAdapterMetadata[] }>('/api/adapters');
}

export async function listRecommendedResources() {
  return request<{ success: true; items: RecommendedResource[] }>('/api/resources');
}

export async function openRecommendedResource(id: string) {
  return request<{ success: true; url: string }>(`/api/resources/${encodeURIComponent(id)}/click`, { method: 'POST' });
}

export async function getPanelAdapter(adapterId: string) {
  return request<{ success: true; adapter: PanelAdapterMetadata }>(`/api/adapters/${encodeURIComponent(adapterId)}`);
}

export async function getDeploymentJob(grantToken: string, jobId: string) {
  return request<{ success: true; job: DeploymentJob }>(`/api/jobs/${encodeURIComponent(jobId)}?grantToken=${encodeURIComponent(grantToken)}`);
}

export async function startDeploymentJob(grantToken: string, taskKey: string, jobId: string) {
  return request<{ success: true; job: DeploymentJob }>(`/api/jobs/${encodeURIComponent(jobId)}/start`, {
    method: 'POST', body: JSON.stringify({ grantToken, taskKey }),
  });
}

export async function cancelDeploymentJob(grantToken: string, taskKey: string, jobId: string) {
  return request<{ success: true; job: DeploymentJob }>(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST', body: JSON.stringify({ grantToken, taskKey }),
  });
}

export async function retryDeploymentJob(grantToken: string, taskKey: string, jobId: string) {
  return request<{ success: true; job: DeploymentJob }>(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST', body: JSON.stringify({ grantToken, taskKey }),
  });
}

export function subscribeDeploymentJob(grantToken: string, jobId: string, onEvent: (event: DeploymentJobEvent) => void, afterSequence = 0) {
  const source = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events?grantToken=${encodeURIComponent(grantToken)}&after=${afterSequence}`);
  source.onmessage = event => {
    try { onEvent(JSON.parse(event.data) as DeploymentJobEvent); } catch { /* Ignore malformed events; the next persisted event can be replayed. */ }
  };
  source.addEventListener('queued', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('started', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('step_started', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('step_succeeded', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('step_failed', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('step_cancelled', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('progress', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('log', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('succeeded', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('failed', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('cancelled', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('timed_out', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('interrupted', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  source.addEventListener('manual', event => { try { onEvent(JSON.parse((event as MessageEvent).data) as DeploymentJobEvent); } catch { /* noop */ } });
  return source;
}
