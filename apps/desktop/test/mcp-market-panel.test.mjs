import { readFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_MCP_CATALOG } from "../../../packages/shared/dist/index.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [panel, page, en, zh] = await Promise.all([
  read("../src/components/settings/McpMarketPanel.tsx"),
  read("../src/components/settings/AgentMcpPage.tsx"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
]);

test("market panel installs through the existing upsert path only", () => {
  assert.match(panel, /resolveCatalogEntry\(/);
  assert.match(panel, /api\.upsertMcpServer\(/);
  assert.match(panel, /level: "global"/);
  assert.match(panel, /scope: GLOBAL_SCOPE/);
  // No other write path may appear.
  assert.doesNotMatch(panel, /mcpImport|writeFile|host\.call\(/);
});

test("install sheet shows the exact command and collects required values", () => {
  assert.match(panel, /settings\.mcpMarket\.willRun/);
  assert.match(panel, /settings\.mcpMarket\.requiredValues/);
  assert.match(panel, /spec\.defaultValue/);
  assert.match(panel, /type="password"/);
});

test("installed state comes from matching server ids", () => {
  assert.match(panel, /installedIds\.includes\(entry\.id\)/);
  assert.match(page, /installedIds=\{\[\.\.\.globalServers, \.\.\.projectServers\]/);
});

test("agents page wires the market view with reload on exit", () => {
  assert.match(page, /view === "market"/);
  assert.match(page, /setView\("servers"\);\s*\n\s*void load\(\)/);
  assert.match(page, /<McpMarketPanel/);
});

test("market strings exist in en and zh-CN", () => {
  for (const locale of [en, zh]) {
    assert.match(locale, /mcpMarket: \{/);
    assert.match(locale, /browse: "/);
    assert.match(locale, /installSuccess: "/);
    assert.match(locale, /"category\.devtools": "/);
  }
});

test("builtin catalog keeps the zero-config promise", () => {
  const zeroConfig = BUILTIN_MCP_CATALOG.servers.filter(
    (entry) => !(entry.requiredEnv?.length ?? 0),
  );
  assert.ok(zeroConfig.length >= 5, `only ${zeroConfig.length} zero-config entries`);
  const ids = BUILTIN_MCP_CATALOG.servers.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate catalog ids");
});
