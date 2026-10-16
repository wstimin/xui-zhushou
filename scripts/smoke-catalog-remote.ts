import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { connectSsh, execSsh, inspectServer } from '../server/ssh.js';
import { registerCatalogAdapters } from '../server/catalog-adapters.js';

// Credentials are supplied through stdin and are never saved in the repository.
async function readInput() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  console.log('Awaiting hidden JSON input');
  const input = createInterface({ input: process.stdin, terminal: false });
  const [line] = await once(input, 'line');
  input.close();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  return JSON.parse(String(line));
}
const credentials = await readInput();
const mode = process.argv[2] || 'inspect';
const session = await connectSsh(credentials, { timeoutMs: 25_000 });
const scrub = (value: unknown) => String(value)
  .replaceAll(String(credentials.sshPassword || '\u0000'), '[redacted]')
  .replace(/(?:CPA_|sk-cpa-)[a-zA-Z0-9_-]+/g, '[redacted]');

async function runTask(task: Record<string, any>) {
  const mode = task.mode;
  const environment = await inspectServer(session, { timeoutMs: 25_000 });
  console.log(JSON.stringify({ stage: 'environment', fingerprint: session.fingerprint, environment }, null, 2));
  if (mode === 'exec') {
    if (!task.command || typeof task.command !== 'string') throw new Error('Missing diagnostic command');
    const result = await execSsh(session.client, task.command, { timeoutMs: Math.min(Number(task.timeoutMs) || 30_000, 20 * 60_000) });
    console.log(scrub(result.stdout));
    if (result.stderr) console.error(scrub(result.stderr));
    console.log(JSON.stringify({ stage: 'remote-command', code: result.code }));
    if (result.code !== 0) throw new Error(`Remote command exited with ${result.code}`);
  } else if (mode === 'inspect') {
    const result = await execSsh(session.client, [
      "printf '\\nEXISTING_SERVICES\\n'; systemctl list-units --type=service --state=running --no-pager --no-legend",
      "printf '\\nCONTAINERS\\n'; if command -v docker >/dev/null; then docker ps -a --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}'; docker info --format 'Docker={{.ServerVersion}}'; fi",
      "printf '\\nLISTENING_PORTS\\n'; ss -lntp",
      "printf '\\nEXISTING_PANEL_DATA\\n'; for target in /www/server/panel /opt/1panel /opt/panelark/new-api /opt/panelark/one-api /opt/panelark/cliproxyapi; do if test -e \"$target\"; then ls -ld \"$target\"; fi; done",
      "printf '\\nVIRTUALIZATION\\n'; systemd-detect-virt || true; test ! -e /dev/kvm || ls -l /dev/kvm; for name in qemu-system-x86_64 systemd-nspawn machinectl virt-install; do command -v \"$name\" || true; done",
      "printf '\\nPANELARK_HEALTH\\n'; curl -fsS --max-time 5 http://127.0.0.1:1888/api/health || true",
    ].join('; '), { timeoutMs: 25_000 });
    console.log(scrub(result.stdout));
    if (result.stderr) console.error(scrub(result.stderr));
  } else {
    const id = mode;
    if (!['bt-panel', 'new-api', 'one-api', 'cliproxyapi'].includes(id)) throw new Error('Unknown remote smoke adapter');
    const adapter = registerCatalogAdapters().find(item => item.metadata.id === id)!;
    const payload = { ...credentials, sshSession: session, ...(task.payload || {}) };
    const context = {
      payload, jobId: `remote-acceptance-${Date.now()}`, attempt: 1, signal: new AbortController().signal,
      async step<T>(key: string, run: () => Promise<T>) { console.log(JSON.stringify({ stage: key, status: 'running' })); const result = await run(); console.log(JSON.stringify({ stage: key, status: 'passed' })); return result; },
      log(message: string) { console.log(JSON.stringify({ log: scrub(message) })); },
      progress(percent: number, message: string) { console.log(JSON.stringify({ percent, message })); },
      residue() {}, checkCancelled() {},
    };
    const result = await adapter.execute('install', context) as Record<string, unknown>;
    const safeResult = Object.fromEntries(Object.entries(result).filter(([key]) => !/password|token|secret|key|installInfo|username/i.test(key)));
    console.log(JSON.stringify({ stage: 'delivery', result: safeResult }, null, 2));
  }
}

try {
  await runTask({ ...credentials, mode });
} catch (error) {
  console.error(scrub(error instanceof Error ? error.message : error));
  process.exitCode = 1;
} finally {
  session.client.end();
}
