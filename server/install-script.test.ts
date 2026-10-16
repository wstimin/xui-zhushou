import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

const installer = readFileSync(new URL("../install.sh", import.meta.url), "utf8");

test("PM2 reads the release version instead of inheriting a previous updater version", () => {
  const previous = process.env.APP_VERSION;
  process.env.APP_VERSION = "0.0.1-stale";
  try {
    const require = createRequire(import.meta.url);
    const config = require("../ecosystem.config.cjs");
    const pkg = require("../package.json");
    assert.equal(config.apps[0].env.APP_VERSION, pkg.version);
    assert.equal(config.apps[0].name, "panelark");
    assert.equal(config.apps[0].env.PANELARK_DEPLOYMENT_MODE, "standalone");
  } finally {
    if (previous === undefined) delete process.env.APP_VERSION; else process.env.APP_VERSION = previous;
  }
});

test("one-click installer uses a supported LTS runtime and verifies node plus npm", () => {
  assert.match(installer, /MIN_NODE_MAJOR="24"/);
  assert.match(installer, /setup_\$\{MIN_NODE_MAJOR\}\.x/);
  assert.doesNotMatch(installer, /setup_20\.x|Node\.js (?:LTS )?\(v20\)/);
  assert.match(installer, /command -v node[^\n]+command -v npm/);
  assert.match(installer, /installed_major=.*process\.versions\.node/);
  assert.match(installer, /installed_major[^\n]+MIN_NODE_MAJOR/);
});

test("one-click installer fails closed when runtime setup or production dependencies fail", () => {
  assert.match(installer, /set -o pipefail/);
  assert.match(installer, /curl -fsSL --retry 3 --connect-timeout 15 "\$setup_url" -o "\$setup_script"/);
  assert.match(installer, /if ! env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a bash "\$setup_script"/);
  assert.match(installer, /if ! npm ci --omit=dev --ignore-scripts/);
  assert.match(installer, /旧版本未被替换/);
});

// These run real Bash functions (including generated shortcuts), not text-only assertions.
// Linux CI runs them; Windows has no guaranteed POSIX runtime.
const shellTest = process.platform === "win32" && !process.env.PANELARK_TEST_BASH ? test.skip : test;
const scriptPath = fileURLToPath(new URL("../install.sh", import.meta.url));
const bashPath = (value: string) => process.platform === "win32" ? value.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`) : value;
function shell(body: string, options: { installed?: boolean; version?: string; manifestVersion?: string; tamper?: boolean; input?: string } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "panelark-cli-"));
  const app = path.join(directory, "app"); mkdirSync(app);
  if (options.installed) {
    mkdirSync(path.join(app, "dist")); writeFileSync(path.join(app, "dist/server.cjs"), "test");
    writeFileSync(path.join(app, "VERSION"), options.version || "2.2.1");
    writeFileSync(path.join(app, "ecosystem.config.cjs"), "test");
  }
  if (options.manifestVersion) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(path.join(app, "release-public-key.pem"), publicKey.export({ type: "spki", format: "pem" }));
    const manifest = { schemaVersion: 1, product: "PanelArk", version: options.manifestVersion, packageUrl: `https://example.com/v${options.manifestVersion}/xui-zhushou-linux-v${options.manifestVersion}.tar.gz` };
    const signature = sign(null, Buffer.from(JSON.stringify(manifest)), privateKey).toString("base64");
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, version: options.tamper ? "9.9.9" : manifest.version, signature }));
  }
  try {
    const result = spawnSync(process.env.PANELARK_TEST_BASH || "bash", ["-c", `source "$1"
TARGET_DIR="$2/app"; ACTIVE_PROJECT_DIR="$TARGET_DIR"; SHORTCUT_DIR="$2/bin"; INSTALL_LOCK_FILE="$2/install.lock"
check_root() { :; }; pause_if_tty() { :; }
${body}`, "cli-test", bashPath(scriptPath), bashPath(directory)], { input: options.input || "", encoding: "utf8", timeout: 15000 });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr, marker: existsSync(path.join(directory, "unexpected")) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

shellTest("installed CLI refuses duplicate installation before dependencies, downloads or PM2", () => {
  const result = shell(`install_base_deps() { echo UNEXPECTED_DEPS; exit 91; }
download_release_package() { exit 92; }
pm2() { exit 93; }
install_assistant`, { installed: true });
  assert.equal(result.status, 0); assert.match(result.output, /不会重复安装/); assert.doesNotMatch(result.output, /UNEXPECTED_DEPS/);
});

shellTest("unknown CLI command is rejected without invoking installation", () => {
  const result = shell(`install_assistant() { echo UNEXPECTED_INSTALL; }; main typo`);
  assert.equal(result.status, 1); assert.doesNotMatch(result.output, /UNEXPECTED_INSTALL/);
});

shellTest("menu dispatches real actions, survives a failed action and exits on EOF", () => {
  const result = shell(`service_status() { echo 已停止; }
install_assistant() { echo ACTION_INSTALL; }
manage_service() { echo "ACTION_$1"; }
view_logs() { echo ACTION_LOGS; }
update_assistant() { echo ACTION_UPDATE; }
check_update() { echo ACTION_CHECK; }
initialize_from_menu() { echo ACTION_INIT; }
show_menu`, { input: "1\n7\n8\n9\n10\n11\n15\n12\n" });
  assert.equal(result.status, 0);
  for (const action of ["INSTALL", "start", "stop", "restart", "LOGS", "CHECK", "UPDATE", "INIT"]) assert.match(result.output, new RegExp(`ACTION_${action}`));
  const failed = shell(`service_status() { echo 未安装; }; manage_service() { false; echo SHOULD_NOT_CONTINUE; }; view_logs() { echo NEXT_ACTION; }; show_menu`, { input: "7\n10\n" });
  assert.equal(failed.status, 0); assert.match(failed.output, /操作未完成/); assert.match(failed.output, /NEXT_ACTION/); assert.doesNotMatch(failed.output, /SHOULD_NOT_CONTINUE/);
});

shellTest("pa and legacy sy shortcuts forward arguments without installing anything", () => {
  const result = shell(`printf '#!/usr/bin/env bash\nprintf "FORWARDED:<%%s>\\n" "$@"\n' > "$TARGET_DIR/install.sh"
install_shortcut
"$SHORTCUT_DIR/pa" restart
"$SHORTCUT_DIR/sy" logs
"$SHORTCUT_DIR/pa"`);
  assert.equal(result.status, 0); assert.match(result.output, /FORWARDED:<restart>/); assert.match(result.output, /FORWARDED:<logs>/); assert.match(result.output, /FORWARDED:<>/);
});

shellTest("shortcut setup does not overwrite another program named pa", () => {
  const result = shell(`mkdir -p "$SHORTCUT_DIR"; echo FOREIGN_PROGRAM > "$SHORTCUT_DIR/pa"
set +e; install_shortcut; result=$?; set -e
cat "$SHORTCUT_DIR/pa"; test ! -e "$SHORTCUT_DIR/sy"; exit "$result"`);
  assert.equal(result.status, 1); assert.match(result.output, /FOREIGN_PROGRAM/); assert.match(result.output, /未覆盖/);
});

const mockManifestDownload = `pm2() { :; }
curl() { local dest=""; while [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then dest="$2"; shift; fi; shift; done; cp "$(dirname "$TARGET_DIR")/manifest.json" "$dest"; }
install_assistant() { echo "INSTALL:$INSTALL_MODE:$EXPECTED_RELEASE_VERSION:$RELEASE_URL:$RELEASE_CHECKSUM_URL"; }`;

shellTest("same or lower signed version never downloads an archive, installs dependencies or restarts", () => {
  for (const manifestVersion of ["2.2.1", "2.2.0"]) {
    const result = shell(`${mockManifestDownload}\nupdate_assistant`, { installed: true, manifestVersion });
    assert.equal(result.status, 0); assert.match(result.output, /不下载、不重复安装、不重启/); assert.doesNotMatch(result.output, /INSTALL:/);
  }
});

shellTest("new signed version pins update to that release and rejects tampered manifests", () => {
  const options = { installed: true, manifestVersion: "2.3.0" };
  const valid = shell(`${mockManifestDownload}\nupdate_assistant`, options);
  assert.equal(valid.status, 0); assert.match(valid.output, /INSTALL:update:2\.3\.0:https:\/\/example.com\/v2.3.0\/xui-zhushou-linux-v2.3.0.tar.gz:https:\/\/example.com\/v2.3.0\/SHA256SUMS/);
  const invalid = shell(`${mockManifestDownload}\nupdate_assistant`, { ...options, tamper: true });
  assert.equal(invalid.status, 1); assert.match(invalid.output, /验证失败/); assert.doesNotMatch(invalid.output, /INSTALL:/);
});

test("installation lock rejects a concurrent deployment before any package operation", { skip: process.platform === "win32" }, () => {
  const result = shell(`exec 8>"$INSTALL_LOCK_FILE"; flock -n 8
install_base_deps() { echo UNEXPECTED_DEPS; }
install_assistant`);
  assert.equal(result.status, 1); assert.match(result.output, /另一安装\/更新任务正在执行/); assert.doesNotMatch(result.output, /UNEXPECTED_DEPS/);
});

shellTest("service controls call only this PM2 application and verify starts", () => {
  const result = shell(`pm2() { echo "PM2:$*"; }
migrate_legacy_process() { :; }
acquire_management_lock() { :; }
verify_running_release() { echo HEALTH_VERIFIED; }
service_status() { echo 运行中; }
manage_service start; manage_service stop; manage_service restart; view_logs`, { installed: true });
  assert.equal(result.status, 0); assert.match(result.output, /PM2:startOrReload ecosystem.config.cjs --update-env/);
  assert.match(result.output, /PM2:stop panelark/); assert.match(result.output, /PM2:logs panelark --lines 100 --nostream/);
  assert.equal((result.output.match(/HEALTH_VERIFIED/g) || []).length, 2);
  assert.doesNotMatch(result.output, /PM2:(?:stop|restart|delete) all/);
});

shellTest("service status reads the target process rather than an unrelated online process", () => {
  const result = shell(`pm2() { echo '[{"name":"other","pm2_env":{"status":"online"}},{"name":"panelark","pm2_env":{"status":"stopped"}}]'; }; service_status`, { installed: true });
  assert.equal(result.status, 0); assert.match(result.output, /已停止/); assert.doesNotMatch(result.output, /运行中/);
});

shellTest("legacy process migration deletes only the old process owned by this installation", () => {
  const result = shell(`pm2() {
if [ "$1" = jlist ]; then node -e 'console.log(JSON.stringify([{name:"3xui-deploy-assistant",pm2_env:{pm_cwd:process.argv[1]}}]))' "$TARGET_DIR"; else echo "PM2:$*"; fi
}; migrate_legacy_process`, { installed: true });
  assert.equal(result.status, 0); assert.match(result.output, /PM2:delete 3xui-deploy-assistant/);
  const unrelated = shell(`pm2() { if [ "$1" = jlist ]; then echo '[{"name":"3xui-deploy-assistant","pm2_env":{"pm_cwd":"/some/other/app"}}]'; else echo UNEXPECTED_DELETE; fi; }; migrate_legacy_process`, { installed: true });
  assert.equal(unrelated.status, 0); assert.doesNotMatch(unrelated.output, /UNEXPECTED_DELETE/);
});

shellTest("complete information reads the saved admin path and account, never a plaintext password", () => {
  const result = shell(`touch "$TARGET_DIR/dist/panel-admin.cjs"
account_info() { echo '{"initialized":true,"username":"saved_owner","adminPath":"/saved-console","siteUrl":"https://saved.example.com","siteName":"Saved site"}'; }
get_public_ip() { SERVER_IP=192.0.2.1; }
curl() { echo '{"status":"ok"}'; }
pm2() { if [ "$1" = jlist ]; then echo '[]'; else echo '6.0.0'; fi; }
view_panel_info`, { installed: true });
  assert.equal(result.status, 0);
  for (const value of ["Saved site", "saved_owner", "https://saved.example.com/saved-console", "panelark.sqlite", "Node.js", "PM2", "pa password", "健康检查：通过", "进程名称：panelark"]) assert.ok(result.output.includes(value), value);
});
shellTest("version detection never installs even when a newer signed release exists", () => {
  const result = shell(`${mockManifestDownload}\nmain check-update`, { installed: true, manifestVersion: "2.3.0" });
  assert.equal(result.status, 0); assert.match(result.output, /发现新版本/); assert.doesNotMatch(result.output, /INSTALL:/);
});
