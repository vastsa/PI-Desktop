import {
  readAppSourceSync,
  readMainModuleSync,
  readMainSourceSync,
} from "./helpers/source-contracts.mjs";
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

const main = readMainSourceSync();
const startup = readMainModuleSync("bootstrap/startup.ts");
const shutdown = readMainModuleSync("bootstrap/shutdown.ts");
const pluginIpc = readMainModuleSync("ipc/plugin-ipc.ts");
const workspaceIpc = readMainModuleSync("ipc/workspace-ipc.ts");
const extensionIpc = readMainModuleSync("agent-extensions-ipc.ts");
const app = readAppSourceSync();
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
  assert.match(startup, /const invokeIpc = registerIpc\(\)/);
  assert.match(startup, /process\.env\.PI_DESKTOP_MCP_CONTROL === "1"/);
  assert.match(startup, /channels: IPC\.invoke/);
  assert.match(startup, /version: APP_VERSION/);
  assert.match(startup, /mcpControlRendererEvent/);
  assert.match(startup, /process\.env\.PI_DESKTOP_MCP_PORT/);
  assert.match(shutdown, /getMcpControl\(\)\?\.stop\(\)/);
  assert.match(api, /projectPath\?: string \| null/);
  assert.match(api, /selectSessionId\?: string/);
  assert.match(app, /event\.projectPath/);
  assert.match(app, /event\.selectSessionId/);
  assert.match(app, /openProjectPath\(event\.projectPath\)/);
});

test("native picker handlers and secret-write channels stay out of the MCP catalog", () => {
  const pickerKeys = [];
  const handlePattern = /handle(?:WithEvent)?\(\s*IPC\.invoke\.([A-Za-z0-9_]+)/g;
  for (const source of [pluginIpc, workspaceIpc, extensionIpc]) {
    const starts = [...source.matchAll(handlePattern)];
    for (let index = 0; index < starts.length; index += 1) {
      const from = starts[index].index ?? 0;
      const to = index + 1 < starts.length ? (starts[index + 1].index ?? source.length) : source.length;
      const block = source.slice(from, to);
      if (block.includes("showOpenDialog")) pickerKeys.push(starts[index][1]);
    }
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
