import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const statePath = path.resolve(argument("--state"));
const target = path.resolve(argument("--target"));
const dataDirectory = path.dirname(statePath);
const targetParent = path.dirname(target);
const targetName = path.basename(target);
const candidate = path.join(targetParent, `.${targetName}.update-${process.pid}`);
const rollback = path.join(targetParent, `.${targetName}.rollback`);

function safeTarget(value) {
  const parsed = path.parse(value);
  return path.isAbsolute(value) && value !== parsed.root && value.length > parsed.root.length + 3;
}

if (!safeTarget(target) || !safeTarget(candidate) || !safeTarget(rollback) || !fs.existsSync(path.join(target, "package.json"))) {
  throw new Error("拒绝在不安全的目标目录执行更新");
}

function readState() { return JSON.parse(fs.readFileSync(statePath, "utf8")); }
function writeState(patch) {
  const previous = readState();
  const updatedAt = new Date().toISOString();
  const next = { ...previous, ...patch, updatedAt, events: [...(previous.events || []).slice(-99), { phase: patch.phase || previous.phase, progress: patch.progress ?? previous.progress, message: patch.message || previous.message, at: updatedAt }] };
  const temporary = `${statePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, statePath);
  return next;
}

function run(command, args, cwd, environment = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 10 * 60_000, env: { ...process.env, ...environment } });
  if (result.error || result.status !== 0) throw new Error(`${command} 执行失败：${result.error?.message || result.stderr || result.stdout || result.status}`.slice(0, 2000));
  return result.stdout;
}

function parseEnv(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function checkHealth(port, secure, version) {
  const client = secure ? https : http;
  return new Promise(resolve => {
    const request = client.get({ hostname: "127.0.0.1", port, path: "/api/health", timeout: 5000, rejectUnauthorized: false }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        try { const payload = JSON.parse(body); resolve(response.statusCode === 200 && payload.version === version); } catch { resolve(false); }
      });
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => { request.destroy(); resolve(false); });
  });
}

async function waitForHealth(version, env) {
  const port = Number(env.PORT || 1888);
  const certPath = env.SSL_CERT || "/etc/3xui-assistant/ssl/cert.pem";
  const keyPath = env.SSL_KEY || "/etc/3xui-assistant/ssl/key.pem";
  const secure = fs.existsSync(certPath) && fs.existsSync(keyPath);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await checkHealth(port, secure, version)) return true;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

let swapped = false;
function removeOwnedLegacyProcess() {
  const processes = JSON.parse(run("pm2", ["jlist"], target));
  if (processes.some(p => p.name === "3xui-deploy-assistant" && path.resolve(p.pm2_env?.pm_cwd || "/") === target)) {
    run("pm2", ["delete", "3xui-deploy-assistant"], target);
  }
}
try {
  const state = readState();
  const archive = path.resolve(String(state.archivePath || ""));
  const updateRoot = path.resolve(path.join(dataDirectory, "updates"));
  if (!archive.startsWith(`${updateRoot}${path.sep}`) || !fs.existsSync(archive)) throw new Error("更新包路径无效或文件不存在");
  writeState({ phase: "applying", progress: 60, message: "正在校验更新包目录结构" });
  const entries = run("tar", ["-tzf", archive], targetParent).split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.some(entry => path.isAbsolute(entry) || entry.split(/[\\/]/).includes(".."))) throw new Error("更新包包含不安全路径");
  fs.rmSync(candidate, { recursive: true, force: true });
  fs.mkdirSync(candidate, { recursive: true });
  run("tar", ["-xzf", archive, "-C", candidate], targetParent);
  const version = fs.readFileSync(path.join(candidate, "VERSION"), "utf8").trim();
  if (version !== state.targetVersion || !fs.existsSync(path.join(candidate, "dist", "server.cjs")) || !fs.existsSync(path.join(candidate, "scripts", "apply-update.mjs"))) throw new Error("更新包版本或结构与签名清单不一致");
  writeState({ phase: "applying", progress: 68, message: "正在安装锁定的生产依赖" });
  run("npm", ["ci", "--omit=dev", "--ignore-scripts"], candidate);
  if (fs.existsSync(path.join(target, ".env"))) fs.copyFileSync(path.join(target, ".env"), path.join(candidate, ".env"));
  const env = parseEnv(path.join(candidate, ".env"));
  writeState({ phase: "applying", progress: 78, message: "正在原子切换到新版本" });
  fs.rmSync(rollback, { recursive: true, force: true });
  fs.renameSync(target, rollback);
  fs.renameSync(candidate, target);
  swapped = true;
  writeState({ phase: "restarting", progress: 86, message: "新版本已切换，正在重启并执行健康检查" });
  removeOwnedLegacyProcess();
  run("pm2", ["startOrReload", "ecosystem.config.cjs", "--update-env"], target, { APP_VERSION: version });
  if (!await waitForHealth(version, env)) throw new Error("新版本未通过健康检查");
  run("pm2", ["save"], target);
  fs.rmSync(rollback, { recursive: true, force: true });
  writeState({ phase: "completed", progress: 100, currentVersion: version, message: `已更新至 v${version}` });
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  if (swapped) {
    try {
      const processes = JSON.parse(run("pm2", ["jlist"], target));
      if (processes.some(p => p.name === "panelark" && path.resolve(p.pm2_env?.pm_cwd || "/") === target)) run("pm2", ["delete", "panelark"], target);
      if (fs.existsSync(target) && safeTarget(target)) fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(rollback, target);
      const previousVersion = fs.readFileSync(path.join(target, "VERSION"), "utf8").trim();
      run("pm2", ["startOrReload", "ecosystem.config.cjs", "--update-env"], target, { APP_VERSION: previousVersion });
      if (!await waitForHealth(previousVersion, parseEnv(path.join(target, ".env")))) throw new Error("旧版本恢复后健康检查未通过");
      run("pm2", ["save"], target);
      writeState({ phase: "rolled_back", progress: 100, message: "更新失败，已自动恢复旧版本", error: reason });
    } catch (rollbackError) {
      writeState({ phase: "failed", progress: 0, message: "更新与自动回滚均失败，需要人工恢复", error: `${reason}; rollback: ${rollbackError instanceof Error ? rollbackError.message : rollbackError}` });
    }
  } else {
    if (fs.existsSync(candidate) && safeTarget(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
    writeState({ phase: "failed", progress: 0, message: "更新失败，当前版本未发生变化", error: reason });
  }
  process.exitCode = 1;
}
