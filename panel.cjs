// Select this file as the application entry in BT / 1Panel Node.js projects.
import("./scripts/panel-start.mjs").catch(error => {
  console.error(`[PanelArk] ${error.message}`);
  process.exitCode = 1;
});
