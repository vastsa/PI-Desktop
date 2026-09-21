import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../electron/main/mcp-registry-catalog.ts", import.meta.url), "utf8");
const panel = await readFile(new URL("../src/components/settings/McpMarketPanel.tsx", import.meta.url), "utf8");

test("market source requests pin the checked DNS address", () => {
  assert.match(source, /lookup\(host, \{ all: true, verbatim: true \}\)/);
  assert.match(source, /hostname: resolved\.address/);
  assert.match(source, /servername: isIP\(host\) \? undefined : host/);
  assert.match(source, /if \(response\.status >= 300 && response\.status < 400\)/);
});
test("fake-IP proxy routes use the session transport without weakening direct pinning", () => {
  assert.match(source, /resolveProxy\(url\)/);
  assert.match(source, /classifyProxyRoute/);
  assert.match(source, /isAcceptableResolvedAddress\(addressKind, route\)/);
  assert.match(source, /resolved\.route === "proxied"/);
  assert.match(source, /requestProxiedHttps/);
  assert.match(source, /net\.fetch\(url/);
  assert.match(source, /requestPinnedHttps\(current, resolved/);
  assert.match(source, /MAX_SOURCE_RESPONSE_BYTES/);
  assert.match(source, /currentNetworkProxy\(\)\.allowFakeIp/);
  assert.match(source, /allowFakeIp && addressKind === "benchmark"/);
});

test("market source responses and caches are bounded", () => {
  assert.match(source, /MAX_SOURCE_RESPONSE_BYTES = 4 \* 1024 \* 1024/);
  assert.match(source, /content-length/);
  assert.match(source, /bytes > MAX_SOURCE_RESPONSE_BYTES/);
  assert.match(source, /MAX_CACHE_ENTRIES = 128/);
  assert.match(source, /MAX_MARKET_SOURCES = 16/);
});

test("registry search exposes cursor pagination to the market UI", () => {
  assert.match(source, /searchRegistry\(source, trimmed, options\.more === true\)/);
  assert.match(source, /if \(state\.cursor\) params\.set\("cursor", state\.cursor\)/);
  assert.match(source, /metadata\?\.nextCursor/);
  assert.match(panel, /remote\.status === "ready" && !remote\.exhausted/);
  assert.doesNotMatch(panel, /!search && remote\.status === "ready"/);
});
