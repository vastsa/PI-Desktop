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
  // No other write path may appear.
  assert.doesNotMatch(panel, /mcpImport|writeFile|host\.call\(/);
});

test("install sheet shows the exact command and collects required values", () => {
  assert.match(panel, /settings\.mcpMarket\.willRun/);
  assert.match(panel, /settings\.mcpMarket\.requiredValues/);
  assert.match(panel, /spec\.defaultValue/);
  assert.match(panel, /type="password"/);
});

test("failed and partial MCP catalog searches can be retried", () => {
  assert.match(panel, /const \[catalogRetry, setCatalogRetry\] = useState\(0\)/);
  assert.match(panel, /\[search, sources, catalogRetry\]/);
  assert.match(panel, /const retryCatalog = \(\) => \{/);
  assert.match(panel, /settings\.mcpMarket\.retry/);
  assert.match(panel, /settings\.mcpMarket\.remotePartial/);
  assert.match(panel, /remote\.status === "ready" && remote\.failed\.length/);
});

test("a failed query keeps the last successful list with its timestamp", () => {
  // Issue #1692 follow-up, MCP side: the last successful registry answer stays
  // on screen when a later query fails, with the time it was taken.
  assert.match(panel, /useState<MarketSnapshot<MarketItem> \| null>\(null\)/);
  assert.match(panel, /snapshotMatchesQuery\(snapshot, search\)/);
  assert.match(panel, /setSnapshot\(\{ entries, at: Date\.now\(\), query: query\.trim\(\) \}\)/);
  assert.match(
    panel,
    /const showingSnapshot =\s*\n\s*snapshotForQuery != null &&\s*\n\s*remote\.entries\.length === 0 &&\s*\n\s*\(remote\.status === "error" \|\| remote\.status === "loading"\)/,
  );
  assert.match(panel, /displayEntries\.filter\(matches\)/);
  assert.match(panel, /settings\.mcpMarket\.remoteStaleSnapshot/);
  // Pagination beyond the first page also refreshes the snapshot: the entries
  // on screen after Load more are what a later failure should keep.
  assert.match(panel, /if \(entries\.length > 0\) \{\s*\n\s*setSnapshot\(/);
});

test("installed state comes from matching server ids", () => {
  assert.match(panel, /installedIds\.includes\(entry\.id\)/);
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
    assert.match(locale, /remotePartial: "/);
    assert.match(locale, /retry: "/);
  }
});

test("every shipped locale carries the MCP market recovery strings", async () => {
  const ids = ["en", "zh-CN", "zh-TW", "de", "es", "fr", "ko", "tr", "pt-BR"];
  for (const id of ids) {
    const locale = await read(`../../../packages/i18n/src/locales/${id}/index.ts`);
    assert.match(locale, /remotePartial: "/, `${id} remotePartial`);
    assert.match(locale, /retry: "/, `${id} retry`);
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
