import assert from "node:assert/strict";
import test from "node:test";
import { buildInstallCommand, formatServerInspectionError, formatSshConnectionError, parseServerInspectionOutput, shellQuote } from "./ssh.js";

test("shellQuote safely escapes single quotes", () => {
  assert.equal(shellQuote("a'b"), "'a'\"'\"'b'");
});

test("formatSshConnectionError gives actionable connection diagnostics", () => {
  assert.equal(
    formatSshConnectionError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
    "SSH 端口拒绝连接，请确认 SSH 服务和端口配置",
  );
  assert.equal(
    formatSshConnectionError(Object.assign(new Error("Timed out while waiting for handshake"), { code: "ETIMEDOUT" })),
    "SSH 连接超时，请检查服务器安全组、防火墙和 SSH 端口",
  );
  assert.equal(
    formatSshConnectionError(new Error("All configured authentication methods failed")),
    "SSH 认证失败，请检查用户名、密码或私钥",
  );
});

test("formatServerInspectionError distinguishes inspection failures from SSH failures", () => {
  assert.equal(
    formatServerInspectionError(new Error("远程命令执行超时")),
    "SSH 已连接，但服务器系统检测未在规定时间内完成",
  );
  assert.equal(
    formatServerInspectionError(new Error("无法执行远程命令: channel open failure")),
    "SSH 已连接，但无法读取服务器系统环境：channel open failure",
  );
});

test("buildInstallCommand uses official noninteractive environment", () => {
  const command = buildInstallCommand({
    scriptUrl: "https://example.com/install.sh",
    username: "admin",
    password: "p@ss'word",
    panelPort: 2053,
    webBasePath: "/xui-test/",
    serverIp: "panel.example.com",
    sslMode: "domain",
    domain: "panel.example.com",
    useSudo: true,
  });

  assert.match(command, /^sudo -n env /);
  assert.match(command, /XUI_NONINTERACTIVE='1'/);
  assert.match(command, /XUI_WEB_BASE_PATH='xui-test'/);
  assert.match(command, /XUI_SSL_MODE='domain'/);
  assert.match(command, /XUI_DOMAIN='panel.example.com'/);
  assert.match(command, /curl -fLsS/);
  assert.doesNotMatch(command, /-s --/);
  assert.doesNotMatch(command, /p@ss'word/);
});

test("official installer is downloaded first and runs without any interactive answer stream", () => {
  const command = buildInstallCommand({
    scriptUrl: "https://raw.githubusercontent.com/MHSanaei/3x-ui/master/install.sh",
    username: "admin_test",
    password: "secret'value",
    panelPort: 2053,
    webBasePath: "/xui-test/",
    serverIp: "panel.example.com",
    sslMode: "none",
    useSudo: false,
  });

  assert.match(command, /MHSanaei\/3x-ui\/master\/install\.sh/);
  assert.match(command, /installer=\$\(mktemp\)/);
  assert.match(command, /<\/dev\/null/);
  assert.match(command, /bash -e -o pipefail -c/);
  assert.doesNotMatch(command, /mogai|interactiveAnswers|x-ui setting|grep -q|\| bash/);
  assert.match(command, /2053/);
  assert.match(command, /XUI_USERNAME=/);
  assert.match(command, /admin_test/);
  assert.match(command, /XUI_WEB_BASE_PATH=/);
  assert.match(command, /xui-test/);
  assert.doesNotMatch(command, /-s --/);
  assert.doesNotMatch(command, /secret'value/);
});

test("buildInstallCommand passes credentials through official environment variables without overwriting official results", () => {
  const command = buildInstallCommand({
    scriptUrl: "https://raw.githubusercontent.com/MHSanaei/3x-ui/master/install.sh",
    username: "owner@example.com",
    password: "safe password ' value",
    panelPort: 54321,
    webBasePath: "/private-panel/",
    serverIp: "203.0.113.10",
    sslMode: "none",
    useSudo: true,
  });

  assert.match(command, /^sudo -n env /);
  assert.match(command, /XUI_PASSWORD=/); assert.match(command, /XUI_PANEL_PORT='54321'/);
  assert.doesNotMatch(command, /x-ui setting|grep -q|systemctl restart/);
  assert.match(command, /owner@example\.com/);
  assert.match(command, /private-panel/);
  assert.doesNotMatch(command, /safe password ' value/);
});

test("parseServerInspectionOutput reports a compatible systemd server", () => {
  const details = parseServerInspectionOutput(
    { host: "203.0.113.10", port: 22, user: "root", fingerprint: "SHA256:test", latencyMs: 42 },
    [
      "__OS__=Debian GNU/Linux 12 (bookworm)",
      "__OS_ID__=debian",
      "__OS_VERSION__=12",
      "__ARCH__=x86_64",
      "__KERNEL__=Linux 6.1.0",
      "__GLIBC__=ldd (Debian GLIBC 2.36) 2.36",
      "__SYSTEMD__=systemd 252 (252.38-1~deb12u1)",
      "__SYSTEMD_ACTIVE__=yes",
      "__RAM_KB__=1048576",
      "__FREE_KB__=524288",
      "__DISK_FREE_KB__=10485760",
      "__CPU__=2",
      "__UID__=0",
      "__CURL__=yes",
      "__PKG_MANAGER__=apt",
    ].join("\n"),
  );

  assert.equal(details.status, "compatible");
  assert.equal(details.systemdAvailable, true);
  assert.equal(details.totalRamMb, 1024);
  assert.equal(details.diskFreeMb, 10240);
  assert.equal(details.packageManager, "apt");
  assert.deepEqual(details.warnings, []);
});

test("parseServerInspectionOutput rejects systems where systemd is not PID 1", () => {
  const details = parseServerInspectionOutput(
    { host: "203.0.113.11", port: 22, user: "root", fingerprint: "SHA256:test", latencyMs: 42 },
    [
      "__OS__=Ubuntu 24.04 LTS",
      "__SYSTEMD__=systemd 255 (255.4-1ubuntu8)",
      "__SYSTEMD_ACTIVE__=no",
      "__RAM_KB__=1048576",
      "__FREE_KB__=524288",
      "__DISK_FREE_KB__=10485760",
      "__CPU__=2",
      "__UID__=0",
      "__CURL__=yes",
      "__PKG_MANAGER__=apt",
    ].join("\n"),
  );

  assert.equal(details.status, "incompatible");
  assert.equal(details.systemdAvailable, false);
  assert.match(details.warnings.join("\n"), /未运行 systemd/);
});
