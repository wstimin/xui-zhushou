import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";

const root = process.cwd();
const releaseDirectory = path.join(root, "release");
const packageDirectory = path.join(releaseDirectory, "package");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const privatePem = process.env.PANELARK_RELEASE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
if (!privatePem) throw new Error("PANELARK_RELEASE_PRIVATE_KEY is required to create a signed release");
const privateKey = createPrivateKey(privatePem);
const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
fs.mkdirSync(packageDirectory, { recursive: true });
fs.writeFileSync(path.join(packageDirectory, "release-public-key.pem"), publicPem, { mode: 0o644 });

if (process.argv.includes("--public-only")) {
  console.log("Prepared release signing public key");
  process.exit(0);
}

const archiveName = `xui-zhushou-linux-v${version}.tar.gz`;
const archivePath = path.join(releaseDirectory, archiveName);
const adapterPath = path.join(root, "config", "adapter-catalog.json");
if (!fs.existsSync(archivePath)) throw new Error(`Release archive is missing: ${archivePath}`);
if (!fs.existsSync(adapterPath)) throw new Error(`Adapter catalog is missing: ${adapterPath}`);
const adapterBytes = fs.readFileSync(adapterPath);
const adapterCatalog = JSON.parse(adapterBytes.toString("utf8"));
if (adapterCatalog.version !== version) throw new Error(`Adapter catalog version ${adapterCatalog.version} does not match package ${version}`);
fs.copyFileSync(adapterPath, path.join(releaseDirectory, "adapter-catalog.json"));

const repository = process.env.GITHUB_REPOSITORY || "wstimin/xui-zhushou";
const baseUrl = `https://github.com/${repository}/releases/download/v${version}`;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const unsigned = {
  schemaVersion: 1,
  product: "PanelArk",
  version,
  channel: process.env.PANELARK_RELEASE_CHANNEL === "beta" ? "beta" : "stable",
  publishedAt: new Date().toISOString(),
  minVersion: process.env.PANELARK_MIN_UPDATE_VERSION || "2.0.0",
  packageUrl: `${baseUrl}/${archiveName}`,
  sha256: sha256(fs.readFileSync(archivePath)),
  notes: (process.env.PANELARK_RELEASE_NOTES || `PanelArk v${version} signed release`).split("|").map(value => value.trim()).filter(Boolean),
  adapterCatalog: {
    version,
    url: `${baseUrl}/adapter-catalog.json`,
    sha256: sha256(adapterBytes),
  },
};
const signature = sign(null, Buffer.from(JSON.stringify(unsigned)), privateKey).toString("base64");
fs.writeFileSync(path.join(releaseDirectory, "release-manifest.json"), `${JSON.stringify({ ...unsigned, signature }, null, 2)}\n`, "utf8");
console.log(`Signed PanelArk v${version} release manifest`);
