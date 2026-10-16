import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
