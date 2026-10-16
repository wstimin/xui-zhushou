import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("请在面板选择 Node.js 24 LTS 或更高版本，再启动 panel.cjs。");
if (fs.existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(args) {
  const result = spawnSync(npm, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, NODE_ENV: "development" } });
  if (result.error || result.status !== 0) throw new Error(`准备运行环境失败（npm ${args.join(" ")}）。请查看上方日志，检查软件源、磁盘空间和 Node.js 版本。`);
}
if (!fs.existsSync(path.join(root, "dist/server.cjs")) || !fs.existsSync(path.join(root, "dist/index.html"))) {
  console.log("[PanelArk] 检测到源码上传，首次启动自动安装构建依赖并生成网页程序，请等待构建完成。");
  run(["ci", "--include=dev", "--ignore-scripts"]);
  run(["run", "build"]);
} else if (!fs.existsSync(path.join(root, "node_modules/express/package.json")) || !fs.existsSync(path.join(root, "node_modules/sql.js/dist/sql-wasm.wasm"))) {
  console.log("[PanelArk] 检测到预编译上传包，正在安装锁定的生产依赖。");
  run(["ci", "--omit=dev", "--ignore-scripts"]);
}
const dataDirectory = path.resolve(process.env.PANELARK_DATA_DIR || path.join(root, "data"));
fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const child = spawn(process.execPath, [path.join(root, "dist/server.cjs")], {
  cwd: root, stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production", PANELARK_DEPLOYMENT_MODE: process.env.PANELARK_DEPLOYMENT_MODE || "panel", PANELARK_DATA_DIR: dataDirectory },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(`[PanelArk] 启动失败：${error.message}`); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1); });
