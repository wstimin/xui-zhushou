import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDependencyInstallCommand,
  buildDockerInstallCommand,
  buildFirewallCommand,
  buildFirewallVerifyCommand,
  evaluateCompatibility,
  parseDependencyOutput,
  parseFirewallOutput,
  parsePortScanOutput,
} from "./panelark-remote.js";

test("dependency parser reports missing packages without trusting free-form output", () => {
  const dependencies = parseDependencyOutput([
    "__DEP_CURL__=yes",
    "__DEP_CA_CERTIFICATES__=yes",
    "__DEP_TAR__=yes",
    "__DEP_GZIP__=yes",
    "__DEP_UNZIP__=no",
    "__DEP_OPENSSL__=yes",
    "__DEP_SOCAT__=no",
    "__DEP_IPROUTE2__=yes",
  ].join("\n"));
  assert.deepEqual(dependencies.filter(item => !item.installed).map(item => item.id), ["unzip", "socat"]);
});

test("dependency installation uses an allowlist and the detected package manager", () => {
  assert.equal(
    buildDependencyInstallCommand("apt", ["curl", "socat"], true),
    "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get update -y && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y curl socat",
  );
  assert.equal(buildDependencyInstallCommand("dnf", ["openssl"], false), "dnf install -y openssl");
  assert.throws(() => buildDependencyInstallCommand("apt", ["curl", "unknown"], false), /安全允许列表/);
  assert.throws(() => buildDependencyInstallCommand("apk", ["curl"], false), /没有受支持/);
});

test("port parser identifies common services but leaves unknown processes unmanaged", () => {
  const ports = parsePortScanOutput([
    '__PORT__=80|LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1286,fd=6))',
    "__PORT__=443|",
    '__PORT__=8080|LISTEN 0 128 0.0.0.0:8080 0.0.0.0:* users:(("customd",pid=42,fd=8))',
  ].join("\n"));
  assert.deepEqual(ports[0], { port: 80, occupied: true, process: "nginx", pid: 1286, service: "nginx", raw: 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1286,fd=6))' });
  assert.equal(ports[1].occupied, false);
  assert.equal(ports[2].service, undefined);
});

test("firewall parser and commands distinguish safe managed backends", () => {
  assert.deepEqual(parseFirewallOutput("__FIREWALL__=ufw\n__FIREWALL_ACTIVE__=yes\n__FIREWALL_SUMMARY__=ufw"), { kind: "ufw", active: true, summary: "ufw" });
  assert.equal(buildFirewallCommand("ufw", [80, 443], true), "sudo -n ufw allow 80/tcp && sudo -n ufw allow 443/tcp");
  assert.equal(buildFirewallCommand("firewalld", [8080], false), "firewall-cmd --permanent --add-port=8080/tcp && firewall-cmd --reload");
  assert.equal(buildFirewallVerifyCommand("firewalld", [8080], true), "sudo -n firewall-cmd --query-port=8080/tcp");
  assert.equal(buildFirewallCommand("nftables", [80], false), "");
});

test("compatibility evaluation enforces supported systems, architecture and privilege", () => {
  const base = { osId: "ubuntu", osVersion: "24.04", arch: "x86_64", packageManager: "apt", systemdAvailable: true, isRoot: false };
  assert.deepEqual(evaluateCompatibility(base, true), { compatible: true, reasons: [] });
  const rejected = evaluateCompatibility({ ...base, osId: "alpine", osVersion: "3.20", packageManager: "apk", systemdAvailable: false }, false);
  assert.equal(rejected.compatible, false);
  assert.equal(rejected.reasons.length, 4);
});

test("Docker installation commands use distro packages or the official Docker RPM repository", () => {
  const apt = buildDockerInstallCommand("apt", true);
  assert.match(apt, /apt-get install -y docker\.io/);
  assert.match(apt, /docker-compose-v2/);
  const dnf = buildDockerInstallCommand("dnf", false);
  assert.match(dnf, /download\.docker\.com\/linux\/centos\/docker-ce\.repo/);
  assert.match(dnf, /docker-compose-plugin/);
  assert.throws(() => buildDockerInstallCommand("apk", false), /没有受支持/);
});
