import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'config', 'adapter-catalog.json'), 'utf8'));
if ([lock.version, lock.packages?.['']?.version, catalog.version].some(version => version !== packageJson.version)) {
  throw new Error('Release versions must match in package.json, package-lock.json and config/adapter-catalog.json before packaging');
}
const outputDir = path.join(root, "release", "package");
const requiredFiles = [
  ".env.example",
  "ecosystem.config.cjs",
  "install.sh",
  "package.json",
  "package-lock.json",
  "README.md",
  "panel.cjs",
  "Dockerfile",
  "docker-compose.yml",
  ".dockerignore",
];

if (!fs.existsSync(path.join(root, "dist", "server.cjs")) || !fs.existsSync(path.join(root, "dist", "panel-admin.cjs"))) {
  throw new Error("dist/server.cjs is missing; run npm run build first");
}

fs.rmSync(path.join(root, "release"), { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.cpSync(path.join(root, "dist"), path.join(outputDir, "dist"), { recursive: true });

for (const file of requiredFiles) {
  fs.copyFileSync(path.join(root, file), path.join(outputDir, file));
}

fs.mkdirSync(path.join(outputDir, "scripts"), { recursive: true });
fs.copyFileSync(path.join(root, "scripts", "apply-update.mjs"), path.join(outputDir, "scripts", "apply-update.mjs"));
fs.copyFileSync(path.join(root, "scripts", "command-shortcuts.mjs"), path.join(outputDir, "scripts", "command-shortcuts.mjs"));
fs.copyFileSync(path.join(root, "scripts", "panel-start.mjs"), path.join(outputDir, "scripts", "panel-start.mjs"));
fs.cpSync(path.join(root, "deploy"), path.join(outputDir, "deploy"), { recursive: true });
fs.cpSync(path.join(root, "docs", "deployment"), path.join(outputDir, "docs", "deployment"), { recursive: true });
fs.mkdirSync(path.join(outputDir, "docs", "panelark"), { recursive: true });
const acceptanceDocs = fs.readdirSync(path.join(root, "docs", "panelark")).filter(file => /^ACCEPTANCE_[0-9.]+\.md$/.test(file));
for (const file of ["STAGE7_OPERATIONS.md", "STAGE8_RELEASE.md", ...acceptanceDocs]) {
  const source = path.join(root, "docs", "panelark", file);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(outputDir, "docs", "panelark", file));
}

fs.writeFileSync(path.join(outputDir, "VERSION"), `${packageJson.version}\n`, "utf8");
console.log(`Prepared release package for v${packageJson.version} at ${outputDir}`);
