import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const outputDir = path.join(root, "release", "package");
const requiredFiles = [
  ".env.example",
  "ecosystem.config.cjs",
  "install.sh",
  "package.json",
  "package-lock.json",
  "README.md",
];

if (!fs.existsSync(path.join(root, "dist", "server.cjs"))) {
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
fs.mkdirSync(path.join(outputDir, "docs", "panelark"), { recursive: true });
for (const file of ["STAGE7_OPERATIONS.md", "STAGE8_RELEASE.md"]) {
  const source = path.join(root, "docs", "panelark", file);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(outputDir, "docs", "panelark", file));
}

fs.writeFileSync(path.join(outputDir, "VERSION"), `${packageJson.version}\n`, "utf8");
console.log(`Prepared release package for v${packageJson.version} at ${outputDir}`);
