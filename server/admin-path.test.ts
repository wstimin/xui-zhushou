import assert from "node:assert/strict";
import test from "node:test";
import { isAdminPagePath, markAdminHtml, normalizeAdminPath } from "./admin-path.js";

test("admin path normalization accepts safe nested paths and rejects reserved paths", () => {
  assert.equal(normalizeAdminPath(" /control-center/ "), "/control-center");
  assert.equal(normalizeAdminPath("/private/ops_2"), "/private/ops_2");
  assert.throws(() => normalizeAdminPath("admin"), /必须以 \/ 开头/);
  assert.throws(() => normalizeAdminPath("/api/admin"), /保留路径/);
  assert.throws(() => normalizeAdminPath("/assets/admin"), /保留路径/);
});

test("admin page matching does not expose the previous or similar path", () => {
  assert.equal(isAdminPagePath("/control-center", "/control-center"), true);
  assert.equal(isAdminPagePath("/control-center/audit", "/control-center"), true);
  assert.equal(isAdminPagePath("/control-center-copy", "/control-center"), false);
  assert.equal(isAdminPagePath("/admin", "/control-center"), false);
});

test("admin HTML marker is added only for the configured route", () => {
  const html = '<div id="root"></div>';
  assert.match(markAdminHtml(html, true), /data-panelark-view="admin"/);
  assert.equal(markAdminHtml(html, false), html);
});
