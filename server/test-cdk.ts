import { randomUUID } from "node:crypto";
import { PanelArkDatabase } from "./panelark-db.js";
import { hashCdk, loadOrCreatePepper, normalizeCdk } from "./panelark-security.js";

export function issueTestCdk(db: PanelArkDatabase, dataDirectory: string, code: string, maxUses = 10) {
  const normalized = normalizeCdk(code);
  const timestamp = new Date().toISOString();
  const packageId = `test-package-${randomUUID()}`;
  db.run(
    "INSERT INTO cdk_packages(id, name, description, max_uses, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
    [packageId, "自动测试套餐", "仅由自动化测试显式创建", maxUses, timestamp, timestamp],
  );
  db.run(
    "INSERT INTO cdks(id, package_id, code_hash, code_hint, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    [randomUUID(), packageId, hashCdk(normalized, loadOrCreatePepper(dataDirectory)), `…${normalized.slice(-4)}`, timestamp, timestamp],
  );
  return normalized;
}
