import dotenv from "dotenv";
import path from "node:path";
import { readInstallationInfo, initializeInstallation, resetAdministratorPassword } from "./panelark-provision.js";

dotenv.config({ quiet: true });

async function main() {
  const dataDirectory = path.resolve(process.env.PANELARK_DATA_DIR || "data");
  const action = process.argv[2];
  if (action === "info") return readInstallationInfo(dataDirectory);
  if (!["initialize", "password"].includes(action)) throw new Error("未知维护操作");
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) { data += chunk; if (data.length > 8192) throw new Error("输入过长"); }
  const input = JSON.parse(data);
  return action === "initialize" ? initializeInstallation(dataDirectory, input) : resetAdministratorPassword(dataDirectory, input);
}
main().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(`[ERROR] ${error.message}`); process.exitCode = 1; });
