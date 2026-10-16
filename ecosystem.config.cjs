const fs = require("node:fs");
const path = require("node:path");

const versionFile = path.join(__dirname, "VERSION");
const packagedVersion = fs.existsSync(versionFile)
  ? fs.readFileSync(versionFile, "utf8").trim()
  : require("./package.json").version;

module.exports = {
  apps: [
    {
      name: "panelark",
      script: "dist/server.cjs",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        APP_VERSION: packagedVersion || "development",
        PANELARK_DEPLOYMENT_MODE: "standalone",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      time: true,
    },
  ],
};
