import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { getCatalogAdapterDefinitions, registerCatalogAdapters } from "./catalog-adapters.js";
import { listPanelAdapters } from "./panel-adapters.js";
import { panels, tools } from "../src/panelark/catalog.js";

function context(payload: Record<string, any>) {
  const events: string[] = [];
  return {
    payload,
    jobId: "catalog-test",
    signal: new AbortController().signal,
    attempt: 1,
    async step<T>(_key: string, task: () => Promise<T>) { return task(); },
    log(message: string) { events.push(message); },
    progress() {},
    residue() {},
    checkCancelled() {},
    events,
  } as any;
}

test("catalog adapters publish a complete support matrix for panels and tools", () => {
  const definitions = getCatalogAdapterDefinitions();
  assert.equal(definitions.length, 20);
  for (const item of definitions) {
    assert.ok(item.id && item.name && item.category);
    assert.ok(item.requirements.minRamMb > 0);
    assert.ok(item.supportedSystems.length > 0);
    assert.equal(item.operations.includes("install"), true);
  }
  assert.ok(definitions.some(item => item.id === "marzban" && item.requirements.systemd === false));
  assert.ok(definitions.some(item => item.id === "docker" && item.kind === "tool"));
  for (const id of ["portainer", "npm", "nezha", "uptime-kuma", "new-api", "one-api", "cliproxyapi"]) {
    const item = definitions.find(definition => definition.id === id)!;
    assert.deepEqual(item.requirements.architectures, ["amd64", "arm64"]);
    assert.deepEqual(item.requirements.autoInstallDependencies, ["Docker Engine", "Docker Compose"]);
    assert.equal(item.requirements.systemd, true);
  }
  for (const id of ["1panel", "aapanel", "bt-panel"]) assert.equal(definitions.find(item => item.id === id)?.category, "建站面板");
  for (const id of ["new-api", "one-api", "cliproxyapi"]) assert.equal(definitions.find(item => item.id === id)?.category, "AI 面板");
});

test("fallback catalog exposes only registered install adapters", () => {
  registerCatalogAdapters();
  const registered = new Set(listPanelAdapters().map(item => item.id));
  const fallback = [...panels, ...tools];
  assert.equal(fallback.length, 21);
  assert.equal(new Set(fallback.map(item => item.id)).size, fallback.length);
  for (const item of fallback) {
    assert.equal(item.adapterId, item.id);
    assert.equal(registered.has(item.id), true, `${item.id} must have a registered backend adapter`);
  }
});

test("catalog adapter install uses allowlisted commands and verifies the service", async () => {
  const commands: string[] = [];
  const adapters = registerCatalogAdapters({
    connect: async () => ({ client: { end() {} } as any, host: "198.51.100.50", port: 22, user: "root", fingerprint: "SHA256:test", latencyMs: 4, alive: true }) as any,
    inspect: async () => ({ osId: "ubuntu", osVersion: "22.04", packageManager: "apt", totalRamMb: 2048, systemdAvailable: true, isRoot: true, status: "compatible", osName: "Ubuntu", arch: "x86_64" }) as any,
    exec: async (_client, command) => {
      commands.push(command);
      return command.includes("systemctl is-active") ? { code: 0, stdout: "active\n", stderr: "" } : { code: 0, stdout: "installed", stderr: "" };
    },
  });
  const adapter = adapters.find(item => item.metadata.id === "nginx")!;
  const result = await adapter.execute("install", context({ ipOrDomain: "198.51.100.50", sshUser: "root", sshPassword: "secret" }) as any) as any;
  assert.equal(result.adapterId, "nginx");
  assert.equal(result.accessUrl, "http://198.51.100.50:80");
  assert.equal(commands.length, 3);
  assert.ok(commands[0].includes("command -v"));
  assert.ok(commands[1].includes("nginx"));
  assert.ok(commands[1].includes("systemctl enable --now nginx"));
  assert.ok(commands[2].includes("systemctl is-active nginx"));
});

test("catalog adapter refuses an incompatible clean server before installation", async () => {
  let executed = false;
  const adapters = registerCatalogAdapters({
    connect: async () => ({ client: { end() {} } as any, host: "198.51.100.51", port: 22, user: "root", fingerprint: "SHA256:test", latencyMs: 4, alive: true }) as any,
    inspect: async () => ({ osId: "ubuntu", osVersion: "22.04", packageManager: "apt", totalRamMb: 256, systemdAvailable: true, isRoot: true, status: "compatible", osName: "Ubuntu", arch: "x86_64" }) as any,
    exec: async () => { executed = true; return { code: 0, stdout: "active", stderr: "" }; },
  });
  const adapter = adapters.find(item => item.metadata.id === "1panel")!;
  await assert.rejects(adapter.execute("install", context({ ipOrDomain: "198.51.100.51", sshUser: "root", sshPassword: "secret" }) as any), /至少需要 1024MB/);
  assert.equal(executed, false);
});

test("catalog adapter accepts normal provider reservation on a nominal 1 GB VPS", async () => {
  const adapters = registerCatalogAdapters({
    connect: async () => ({ client: { end() {} } as any, host: "198.51.100.56", port: 22, user: "root", fingerprint: "SHA256:test", latencyMs: 4, alive: true }) as any,
    inspect: async () => ({ osId: "debian", osVersion: "12", packageManager: "apt", totalRamMb: 977, systemdAvailable: true, isRoot: true, status: "compatible", osName: "Debian", arch: "x86_64" }) as any,
    exec: async () => ({ code: 0, stdout: "active\n", stderr: "" }),
  });
  const adapter = adapters.find(item => item.metadata.id === "1panel")!;
  const result = await adapter.execute("install", context({ ipOrDomain: "198.51.100.56" }) as any) as any;
  assert.equal(result.adapterId, "1panel");
});

test("catalog adapter blocks CasaOS before its installer requests a TTY on low disk", async () => {
  let executed = false;
  const adapters = registerCatalogAdapters({
    connect: async () => ({ client: { end() {} } as any, host: "198.51.100.57", port: 22, user: "root", fingerprint: "SHA256:test", latencyMs: 4, alive: true }) as any,
    inspect: async () => ({ osId: "debian", osVersion: "12", packageManager: "apt", totalRamMb: 2048, diskFreeMb: 1900, systemdAvailable: true, isRoot: true, status: "compatible", osName: "Debian", arch: "x86_64" }) as any,
    exec: async () => { executed = true; return { code: 0, stdout: "active\n", stderr: "" }; },
  });
  const adapter = adapters.find(item => item.metadata.id === "casaos")!;
  await assert.rejects(adapter.execute("install", context({ ipOrDomain: "198.51.100.57" }) as any), /至少需要 5120MB 可用磁盘空间/);
  assert.equal(executed, false);
});

test("every published catalog adapter passes its controlled install and verify path", async () => {
  const commonOutput = "active\n1.2.3\nmarzban\nportainer\nnpm\nnezha-dashboard\nuptime-kuma\nbbr\n/swapfile\ncertbot 2.0\nPANELARK_BT_PORT=38888\nPANELARK_BT_PATH=/safe-entry\nPANELARK_BT_INFO=address and credentials\npanelark-new-api\npanelark-one-api\npanelark-cliproxyapi\nHTTP 200\nPANELARK_CPA_MANAGEMENT_KEY=CPA_test\nPANELARK_CPA_API_KEY=sk-cpa-test\n";
  const commands: string[] = [];
  const adapters = registerCatalogAdapters({
    connect: async () => ({ client: { end() {} } as any, host: "198.51.100.52", port: 22, user: "root", fingerprint: "SHA256:test", latencyMs: 4, alive: true }) as any,
    inspect: async () => ({ osId: "ubuntu", osVersion: "22.04", packageManager: "apt", totalRamMb: 4096, systemdAvailable: true, isRoot: true, status: "compatible", osName: "Ubuntu", arch: "x86_64" }) as any,
    exec: async (_client, command) => { commands.push(command); return { code: 0, stdout: commonOutput, stderr: "" }; },
  });
  for (const adapter of adapters) {
    commands.length = 0;
    const result = await adapter.execute("install", context({ ipOrDomain: "198.51.100.52", sshUser: "root", sshPassword: "secret" }) as any) as any;
    assert.equal(result.adapterId, adapter.metadata.id);
    assert.ok(commands.length >= 2, `${adapter.metadata.id} must run install and verification commands`);
    if (adapter.metadata.id === "certbot") assert.equal(result.accessUrl, undefined);
    assert.doesNotMatch(commands.at(-1) || "", /grep\s+-[^ ]*q/, `${adapter.metadata.id} verification must preserve output for matching`);
    const installCommand = commands.at(-2) || "";
    if (adapter.metadata.id === "s-ui") {
      assert.match(installCommand, /alireza0\/s-ui\/master\/install\.sh/);
      assert.match(installCommand, /printf '%s\\n'/);
      assert.match(result.accessUrl, /^http:\/\/198\.51\.100\.52:2095\/sui_[a-f0-9]{8}\/$/);
      assert.match(result.username, /^admin_[a-f0-9]{8}$/);
      assert.match(result.password, /^Sui_/);
    }
    if (adapter.metadata.id === "marzban") {
      assert.match(installCommand, /Marzban-scripts\/raw\/master\/marzban\.sh/);
      assert.match(installCommand, /setsid bash/);
      assert.match(installCommand, /docker ps/);
    }
    if (adapter.metadata.id === "1panel") {
      assert.match(installCommand, /PANEL_NON_INTERACTIVE=true/);
      assert.match(installCommand, /PANEL_ENTRANCE=/);
      assert.match(commands.at(-1) || "", /1panel-core.*1panel-agent/);
      assert.match(result.accessUrl, /^http:\/\/198\.51\.100\.52:10086\/[a-f0-9]{16}$/);
      assert.ok(result.username);
      assert.match(result.password, /^[A-Za-z0-9!@#$%*_,.?]{8,30}$/);
    }
    if (adapter.metadata.id === "hiddify") assert.match(installCommand, /i\.hiddify\.com\/release/);
    if (adapter.metadata.id === "aapanel") {
      assert.match(installCommand, /install_panel_en\.sh/);
      assert.match(installCommand, /INSTALL_FORCE=true/);
      assert.match(installCommand, /--safe-path/);
      assert.match(installCommand, /--port '31750'/);
      assert.match(commands.at(-1) || "", /systemctl is-active bt.*\/etc\/init\.d\/bt status/);
      assert.match(commands.at(-1) || "", /Chrome\/141\.0\.0\.0/);
      assert.match(commands.at(-1) || "", /HTTP %s/);
      assert.match(result.accessUrl, /^https:\/\/198\.51\.100\.52:31750\/ark_[a-f0-9]{16}$/);
      assert.ok(result.username);
      assert.ok(result.password);
    }
    if (adapter.metadata.id === "bt-panel") {
      assert.match(installCommand, /download\.bt\.cn\/install\/installStable_12\.sh/);
      assert.match(installCommand, /3Tmtilpm/);
      assert.match(installCommand, /避免覆盖现有面板/);
      assert.match(commands.at(-1) || "", /bt default/);
      assert.equal(result.accessUrl, "https://198.51.100.52:38888/safe-entry");
      assert.equal(result.installInfo, "address and credentials");
    }
    if (adapter.metadata.id === "portainer") assert.match(installCommand, /portainer-ce:lts/);
    if (adapter.metadata.id === "nezha") assert.match(installCommand, /ghcr\.io\/nezhahq\/nezha:latest/);
    if (adapter.metadata.id === "uptime-kuma") assert.match(installCommand, /uptime-kuma:2/);
    if (adapter.metadata.id === "new-api") {
      assert.match(installCommand, /calciumion\/new-api:latest/);
      assert.match(installCommand, /panelark-new-api/);
      assert.match(installCommand, /docker container inspect panelark-new-api/);
      assert.equal(result.accessUrl, "http://198.51.100.52:3000");
    }
    if (adapter.metadata.id === "one-api") {
      assert.match(installCommand, /justsong\/one-api:v0\.6\.10/);
      assert.match(installCommand, /panelark-one-api/);
      assert.match(installCommand, /docker container inspect panelark-one-api/);
      assert.equal(result.accessUrl, "http://198.51.100.52:3002");
      assert.match(result.installInfo, /新建实例默认账号 root/);
    }
    if (adapter.metadata.id === "cliproxyapi") {
      assert.match(installCommand, /eceasy\/cli-proxy-api:latest/);
      assert.match(installCommand, /Cli-Proxy-API-Management-Center/);
      assert.match(installCommand, /credentials\.env/);
      assert.match(installCommand, /config-version: 8/);
      assert.match(installCommand, /management:/);
      assert.match(installCommand, /api-keys:/);
      assert.match(installCommand, /docker container inspect panelark-cliproxyapi/);
      assert.equal(result.accessUrl, "http://198.51.100.52:8317/management.html");
      assert.equal(result.managementKey, "CPA_test");
      assert.equal(result.apiToken, "sk-cpa-test");
      assert.doesNotMatch(result.verification, /CPA_test|sk-cpa-test/);
    }
    if (adapter.metadata.id === "fail2ban") {
      assert.match(installCommand, /backend = systemd/);
      assert.match(installCommand, /systemctl restart fail2ban/);
    }
  }
});

test("Docker catalog adapters automatically install and verify Docker when it is missing", async () => {
  const commands: string[] = [];
  let dependencyChecks = 0;
  const taskContext = context({ ipOrDomain: "198.51.100.53" });
  const adapters = registerCatalogAdapters({
    connect: async () => ({ client: { end() {} } as any, host: "198.51.100.53", port: 22, user: "root", fingerprint: "SHA256:test", latencyMs: 4, alive: true }) as any,
    inspect: async () => ({ osId: "ubuntu", osVersion: "22.04", packageManager: "apt", totalRamMb: 4096, systemdAvailable: true, isRoot: true, status: "compatible", osName: "Ubuntu", arch: "x86_64" }) as any,
    exec: async (_client, command) => {
      commands.push(command);
      if (command.startsWith("for command_name")) {
        dependencyChecks += 1;
        return dependencyChecks === 1 ? { code: 127, stdout: "docker\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
      }
      if (command.includes("grep -E '^portainer$'")) return { code: 0, stdout: "portainer\n", stderr: "" };
      return { code: 0, stdout: "ok\n", stderr: "" };
    },
  });
  const adapter = adapters.find(item => item.metadata.id === "portainer")!;
  const result = await adapter.execute("install", taskContext as any) as any;
  assert.equal(result.adapterId, "portainer");
  assert.ok(commands.some(command => command.includes("apt-get install -y docker.io")));
  assert.ok(commands.some(command => command.includes("docker info")));
  assert.ok(commands.findIndex(command => command.includes("apt-get install -y docker.io")) < commands.findIndex(command => command.includes("portainer-ce:lts")));
  assert.ok(taskContext.events.some((message: string) => message.includes("正在自动安装 Docker Engine 与 Compose")));
  assert.ok(taskContext.events.some((message: string) => message.includes("已自动安装并验证通过")));
});

test("catalog adapters stop before installation when a non-automatic command is missing", async () => {
  const commands: string[] = [];
  const adapters = registerCatalogAdapters({
    connect: async () => ({ client: { end() {} } as any, host: "198.51.100.58", port: 22, user: "root", fingerprint: "SHA256:test", latencyMs: 4, alive: true }) as any,
    inspect: async () => ({ osId: "ubuntu", osVersion: "22.04", packageManager: "apt", totalRamMb: 4096, systemdAvailable: true, isRoot: true, status: "compatible", osName: "Ubuntu", arch: "x86_64" }) as any,
    exec: async (_client, command) => {
      commands.push(command);
      return command.includes("command -v") ? { code: 127, stdout: "curl\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    },
  });
  const adapter = adapters.find(item => item.metadata.id === "s-ui")!;
  await assert.rejects(adapter.execute("install", context({ ipOrDomain: "198.51.100.58" }) as any), /缺少前置命令：curl/);
  assert.equal(commands.length, 1);
});

test("container deployments repair incomplete Docker with sudo and stop on failed verification", async () => {
  for (const verificationSucceeds of [true, false]) {
    const commands: string[] = [];
    let dockerChecks = 0;
    const adapter = registerCatalogAdapters({
      connect: async () => ({ client: { end() {} } }) as any,
      inspect: async () => ({ packageManager: "apt", totalRamMb: 4096, systemdAvailable: true, isRoot: false, arch: "aarch64" }) as any,
      exec: async (_client, command) => {
        commands.push(command);
        if (command.startsWith("command -v docker")) {
          dockerChecks += 1;
          return { code: dockerChecks === 1 || !verificationSucceeds ? 1 : 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "portainer\n", stderr: "" };
      },
    }).find(item => item.metadata.id === "portainer")!;
    const execution = adapter.execute("install", context({ ipOrDomain: "198.51.100.59" }));
    if (verificationSucceeds) await execution;
    else await assert.rejects(execution, /二次验证未通过/);
    assert.ok(commands.some(command => command.includes("sudo -n env DEBIAN_FRONTEND=noninteractive apt-get")));
    assert.ok(commands.some(command => command.includes("sudo -n docker info")));
    assert.equal(commands.some(command => command.includes("portainer-ce:lts")), verificationSucceeds);
  }
});

test("catalog adapters enforce compatibility and safely elevate non-root commands", async () => {
  let commands: string[] = [];
  const incompatible = registerCatalogAdapters({
    connect: async () => ({ client: { end() {} } as any, host: "198.51.100.54", port: 22, user: "root", fingerprint: "SHA256:test", latencyMs: 4, alive: true }) as any,
    inspect: async () => ({ osId: "debian", osVersion: "12", packageManager: "apt", totalRamMb: 4096, systemdAvailable: true, isRoot: true, status: "compatible", osName: "Debian", arch: "x86_64" }) as any,
    exec: async (_client, command) => { commands.push(command); return { code: 0, stdout: "active\n", stderr: "" }; },
  }).find(item => item.metadata.id === "hiddify")!;
  await assert.rejects(incompatible.execute("install", context({ ipOrDomain: "198.51.100.54" }) as any), /Ubuntu 22\.04/);
  assert.equal(commands.length, 0);

  commands = [];
  const elevated = registerCatalogAdapters({
    connect: async () => ({ client: { end() {} } as any, host: "198.51.100.55", port: 22, user: "deploy", fingerprint: "SHA256:test", latencyMs: 4, alive: true }) as any,
    inspect: async () => ({ osId: "ubuntu", osVersion: "22.04", packageManager: "apt", totalRamMb: 4096, systemdAvailable: true, isRoot: false, status: "compatible", osName: "Ubuntu", arch: "x86_64" }) as any,
    exec: async (_client, command) => { commands.push(command); return { code: 0, stdout: "active\n", stderr: "" }; },
  }).find(item => item.metadata.id === "hiddify")!;
  await elevated.execute("install", context({ ipOrDomain: "198.51.100.55" }) as any);
  assert.equal(commands[0], "sudo -n true");
  assert.match(commands.at(-2) || "", /^sudo -n sh -c '/);
  assert.match(commands.at(-2) || "", /i\.hiddify\.com\/release/);
  assert.match(commands.at(-1) || "", /^sudo -n sh -c '/);
});

const bash = process.platform === 'win32'
  ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(file => fs.existsSync(file))
  : 'bash';

test('new adapters use valid shell; repeated AI installs reuse containers and preserve CPA credentials', { skip: !bash }, async () => {
  const commands: string[] = [];
  const output = 'PANELARK_BT_PORT=38888\nHTTP 200\npanelark-new-api\npanelark-one-api\npanelark-cliproxyapi\nHTTP 200\nPANELARK_CPA_MANAGEMENT_KEY=CPA_test\n';
  const adapters = registerCatalogAdapters({
    connect: async () => ({ client: { end() {} } }) as any,
    inspect: async () => ({ osId: 'debian', osVersion: '12', packageManager: 'apt', totalRamMb: 4096, diskFreeMb: 20000, systemdAvailable: true, isRoot: true, arch: 'x86_64' }) as any,
    exec: async (_client, command) => { commands.push(command); return { code: 0, stdout: output, stderr: '' }; },
  });
  for (const id of ['bt-panel', 'new-api', 'one-api', 'cliproxyapi']) {
    commands.length = 0;
    await adapters.find(item => item.metadata.id === id)!.execute('install', context({ ipOrDomain: '198.51.100.60', servicePort: '9317' }));
    const install = commands.at(-2)!;
    const verify = commands.at(-1)!;
    for (const command of [install, verify]) {
      const syntax = spawnSync(bash!, ['-n'], { input: command, encoding: 'utf8' });
      assert.equal(syntax.status, 0, `${id}: ${syntax.stderr}`);
    }
    if (id === 'bt-panel') continue;
    const safeInstall = install.replaceAll('/opt/panelark', '"$test_root"');
    const safeVerify = verify.replaceAll('/opt/panelark', '"$test_root"');
    const script = [
      'set -eu',
      'test_root=$(mktemp -d)',
      'trap \'rm -rf -- "$test_root"\' EXIT',
      process.platform === 'win32' ? 'install() { shift 3; mkdir -p "$@"; }; chmod() { :; }' : ':',
      'docker() { case "$1" in container) test -f "$test_root/container" ;; inspect) echo 9317 ;; run) touch "$test_root/container"; echo run >> "$test_root/actions" ;; start) echo start >> "$test_root/actions" ;; ps) printf "panelark-new-api\\npanelark-one-api\\npanelark-cliproxyapi\\n" ;; esac; }',
      'curl() { case "$*" in *http_code*) printf 200 ;; *) printf \'{"success":true}\' ;; esac; }',
      safeInstall,
      id === 'cliproxyapi' ? 'first_config=$(cat "$test_root/cliproxyapi/config.yaml"); first_credentials=$(cat "$test_root/cliproxyapi/credentials.env")' : ':',
      safeInstall,
      'test "$(grep -c run "$test_root/actions")" = 1; test "$(grep -c start "$test_root/actions")" = 1',
      id === 'cliproxyapi' ? 'test "$first_config" = "$(cat "$test_root/cliproxyapi/config.yaml")"; test "$first_credentials" = "$(cat "$test_root/cliproxyapi/credentials.env")"; grep -E \'^MANAGEMENT_KEY=CPA_[a-f0-9]{48}$\' "$test_root/cliproxyapi/credentials.env" >/dev/null' : ':',
      id === 'cliproxyapi' && process.platform !== 'win32' ? 'test "$(stat -c %a "$test_root/cliproxyapi/credentials.env")" = 600' : ':',
      safeVerify,
      'curl() { printf 503; }; sleep() { :; }',
      `if ( ${safeVerify} ); then echo failed-health-check-accepted >&2; exit 1; fi`,
      'docker() { case "$1" in container) return 0 ;; inspect) echo 1111 ;; *) echo unexpected-operation >&2; return 99 ;; esac; }',
      `if ( ${safeInstall} ); then echo mismatched-port-accepted >&2; exit 1; fi`,
    ].join('\n');
    const simulation = spawnSync(bash!, ['-s'], { input: script, encoding: 'utf8', timeout: 15000 });
    assert.equal(simulation.status, 0, `${id}: ${simulation.stderr}`);
  }
});
