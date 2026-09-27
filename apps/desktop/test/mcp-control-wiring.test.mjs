import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  MCP_CONTROL_BLOCKED_CHANNEL_KEYS,
  MCP_CONTROL_CATALOG_CHANNEL_KEYS,
  createMcpControlOperations,
} = await import("../electron/main/mcp-control.ts");

const main = readFileSync(join(desktopRoot, "electron/main/index.ts"), "utf8");
const app = readFileSync(join(desktopRoot, "src/App.tsx"), "utf8");
const api = readFileSync(join(desktopRoot, "src/lib/api.ts"), "utf8");
const protocol = readFileSync(
  join(desktopRoot, "../../packages/shared/src/protocol.ts"),
  "utf8",
);

function ipcInvokeKeys(source) {
  const block = source.match(/invoke:\s*\{([\s\S]*?)\n  \},/)?.[1] ?? "";
  return [...block.matchAll(/^\s+([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
}

test("the optional MCP control server reuses IPC and synchronizes renderer state", () => {
  assert.match(main, /const invokeIpc = registerIpc\(\)/);
  assert.match(main, /process\.env\.PI_DESKTOP_MCP_CONTROL === "1"/);
  assert.match(main, /channels: IPC\.invoke/);
  assert.match(main, /version: APP_VERSION/);
  assert.match(main, /mcpControlRendererEvent/);
  assert.match(main, /process\.env\.PI_DESKTOP_MCP_PORT/);
  assert.match(main, /mcpControl\?\.stop\(\)/);
  assert.match(api, /projectPath\?: string \| null/);
  assert.match(api, /selectSessionId\?: string/);
  assert.match(app, /event\.projectPath/);
  assert.match(app, /event\.selectSessionId/);
  assert.match(app, /openProjectPath\(event\.projectPath\)/);
});

test("native picker handlers and secret-write channels stay out of the MCP catalog", () => {
  const pickerKeys = [];
  const handlePattern = /handle(?:WithEvent)?\(\s*IPC\.invoke\.([A-Za-z0-9_]+)/g;
  const starts = [...main.matchAll(handlePattern)];
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index].index ?? 0;
    const to = index + 1 < starts.length ? (starts[index + 1].index ?? main.length) : main.length;
    const block = main.slice(from, to);
    if (block.includes("showOpenDialog")) pickerKeys.push(starts[index][1]);
  }
  assert.ok(pickerKeys.includes("pluginLoadDev"));
  assert.ok(pickerKeys.includes("projectOpen"));

  const catalog = new Set(MCP_CONTROL_CATALOG_CHANNEL_KEYS);
  const invokeKeys = new Set(ipcInvokeKeys(protocol));
  for (const key of pickerKeys) {
    assert.equal(catalog.has(key), false, `${key} is a native picker`);
  }
  for (const key of MCP_CONTROL_BLOCKED_CHANNEL_KEYS) {
    assert.equal(catalog.has(key), false, `${key} must stay excluded`);
    assert.equal(invokeKeys.has(key), true, `${key} must remain an IPC channel`);
  }
  for (const key of MCP_CONTROL_CATALOG_CHANNEL_KEYS) {
    assert.equal(invokeKeys.has(key), true, `${key} is not an IPC.invoke channel`);
  }
  const channels = Object.fromEntries(
    MCP_CONTROL_CATALOG_CHANNEL_KEYS.map((key) => [key, `pi-desktop/${key}`]),
  );
  channels.pluginLoadDev = "pi-desktop/plugin/loadDev";
  channels.secretsSet = "pi-desktop/secrets/set";
  channels.providersCreate = "pi-desktop/providers/create";
  const live = createMcpControlOperations(channels);
  assert.equal(live.some((operation) => operation.id === "plugin/loadDev"), false);
  assert.equal(live.some((operation) => operation.id === "providers/create"), false);
  assert.equal(live.find((operation) => operation.id === "session/configure")?.risk, "dangerous");
});
