import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { BUILTIN_MCP_CATALOG, IPC } from "@pi-desktop/shared";
import { AgentMcpPage } from "../../apps/desktop/src/components/settings/AgentMcpPage";
import { McpMarketPanel } from "../../apps/desktop/src/components/settings/McpMarketPanel";
import { ToastHost } from "../../apps/desktop/src/components/Toast";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const projectPath = "/projects/market-owner-a";
const otherProjectPath = "/projects/market-owner-b";
const entry = BUILTIN_MCP_CATALOG.servers.find((item) => !item.requiredEnv?.length);
const settings = { defaultMode: "agent", theme: "light", language: "en" };
let records = [], writes = [], imports = [], hasProject = true;
Object.defineProperty(window, "AudioContext", { configurable: true, value: undefined });
window.piDesktop = {
  platform: "darwin",
  on() { return () => {}; },
  async invoke(channel, input) {
    let data;
    switch (channel) {
      case IPC.invoke.projectList:
        data = { projects: hasProject ? [{ id: 1, path: projectPath, name: "Market Project" }, { id: 2, path: otherProjectPath, name: "Other Project" }] : [] };
        break;
      case IPC.invoke.mcpList:
        data = { servers: records.filter((record) => record.level === input.level &&
          (record.level === "global" || record.projectPath === input.projectPath)), statuses: [] };
        break;
      case IPC.invoke.settingsGet:
        data = settings;
        break;
      case IPC.invoke.mcpMarketSearch:
        data = { entries: [], exhausted: true };
        break;
      case IPC.invoke.mcpUpsert:
        writes.push(input);
        data = { server: { ...input, enabled: true } };
        records.push(data.server);
        break;
      case IPC.invoke.mcpImportScan:
        data = { candidates: [{ source: "codex", sourcePath: "/fixture/config.toml", id: "imported", rawKey: "imported", label: "Imported fixture", transport: "stdio", command: "fixture-server", warnings: [] }], sources: [] };
        break;
      case IPC.invoke.mcpImportRun:
        imports.push(input);
        data = { imported: input.items.map(item => ({ item, server: { ...item, level: input.level, projectPath: input.projectPath } })), skipped: [], failed: [] };
        break;
      default:
        throw new Error("Unexpected fixture IPC: " + channel);
    }
    return { ok: true, data };
  },
};
await i18n.use(initReactI18next).init({
  lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false },
});
const root = createRoot(document.getElementById("root"));
const assert = (value, message) => { if (!value) throw new Error(message); };
async function until(predicate, message) {
  const deadline = performance.now() + 5000;
  while (!predicate() && performance.now() < deadline) await new Promise(requestAnimationFrame);
  assert(predicate(), message);
}
const click = (node) => { assert(node, "Missing action"); flushSync(() => node.click()); };
const type = (node, value) => {
  assert(node, "Missing input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value);
  flushSync(() => node.dispatchEvent(new Event("input", { bubbles: true })));
};
const button = (label) => [...document.querySelectorAll("button")]
  .find((node) => node.textContent.trim() === label);
const marketAction = () => [...document.querySelectorAll(".mcpm-card")]
  .find((node) => node.querySelector(".mcpm-name")?.textContent === entry.name)
  ?.querySelector("button");
async function openMarket() {
  click(button(i18n.t("settings.mcpMarket.browse")));
  await until(marketAction, "Market entry did not render");
}
async function install() {
  assert(!marketAction().disabled, "An entry in another owner must not block installation");
  click(marketAction());
  click(document.querySelector('[role="dialog"] .ext-sheet-actions button.mcpm-install:not(.is-ghost)'));
  await until(() => !document.querySelector(".mcpm"), "Install did not return to MCP settings");
}
async function selectOtherProject() {
  click(document.querySelector('.agent-capability-project-select .settings-menu-select-trigger'));
  await until(() => document.querySelector('[role="option"]'), "Project options missing");
  click([...document.querySelectorAll('[role="option"]')].find(node => node.textContent.trim() === "Other Project"));
  await until(() => document.querySelector('.agent-capability-project-select').textContent.includes("Other Project"), "Project did not change");
}
window.mcpMarketOwnerProbe = async () => {
  const results = [];
  for (const [filter, project, otherOwner] of [
    ["project", projectPath, false], ["all", projectPath, false],
    ["global", projectPath, false], ["all", null, false],
    ["project", projectPath, true], ["all", projectPath, true],
  ]) {
    flushSync(() => root.render(null));
    hasProject = Boolean(project);
    writes = [];
    imports = [];
    const level = filter === "project" || (filter === "all" && project) ? "project" : "global";
    records = otherOwner ? [{ ...entry, label: entry.name, enabled: true,
      level: level === "global" ? "project" : "global", projectPath }] : [];
    useAppStore.setState({ settings, workspace: project ? { path: project, name: "Market Project" } : null });
    flushSync(() => root.render(<><AgentMcpPage /><ToastHost /></>));
    await until(() => document.querySelector('.agent-capability-segment button[role="radio"]'), "MCP filters missing");
    click([...document.querySelectorAll('.agent-capability-segment button[role="radio"]')]
      .find((node) => node.textContent.trim().startsWith(i18n.t("settings.capabilityFilter" + filter[0].toUpperCase() + filter.slice(1)))));
    click(button(i18n.t("settings.addMcp")));
    type(document.querySelector('input[placeholder="' + i18n.t("extensions.mcp.labelPlaceholder") + '"]'), "Owner fixture");
    type(document.querySelector('input[placeholder="-y @upstash/context7-mcp"]'), "-y fixture-server");
    click(button(i18n.t("common.save")));
    await until(() => writes.length === 1, "Create did not save");
    assert(writes[0].level === level, "Creation wrote to wrong level");
    assert(writes[0].projectPath === (level === "project" ? project : undefined), "Creation wrote to wrong project");
    await until(() => !document.querySelector('[role="dialog"]'), "Editor did not close");
    click(document.querySelector('[aria-controls="agent-mcp-import-panel"]'));
    click(button(i18n.t("settings.importScan")));
    await until(() => document.querySelector('.import-select-all input'), "Imported candidates missing");
    click(document.querySelector('.import-select-all input'));
    click(button(i18n.t("settings.importSelected", { count: 1 })));
    await until(() => imports.length === 1, "Import did not save");
    assert(imports[0].level === level && imports[0].projectPath === (level === "project" ? project : undefined), "Import wrote to wrong owner");
    writes = [];
    await openMarket();
    await install();
    assert(writes.length === 1, "Market must save one server");
    assert(writes[0].level === level, filter + " installation wrote to " + writes[0].level);
    assert(writes[0].projectPath === (level === "project" ? project : undefined), "Wrong project owner");
    await until(() => [...document.querySelectorAll(".agent-capability-name")]
      .some((node) => node.textContent === entry.name), "Installed server is not visible");
    await openMarket();
    await until(() => marketAction()?.disabled, "Installed state must follow the destination owner");
    results.push({ filter, project, otherOwner, level: writes[0].level });
  }
  // An existing global or project record retains its owner after the page's
  // selected project changes while the editor is open.
  for (const level of ["global", "project"]) {
    flushSync(() => root.render(null));
    hasProject = true;
    writes = [];
    records = [{ id: "existing", label: "Existing fixture", command: "fixture-server", transport: "stdio", enabled: true, level,
      ...(level === "project" ? { projectPath } : {}) }];
    useAppStore.setState({ settings, workspace: { path: projectPath, name: "Market Project" } });
    flushSync(() => root.render(<AgentMcpPage />));
    await until(() => document.querySelector('.agent-capability-row'), "Existing record missing");
    click(document.querySelector('[aria-label="' + i18n.t("settings.editMcpOf", { name: "Existing fixture" }) + '"]'));
    await selectOtherProject();
    click(button(i18n.t("common.save")));
    await until(() => writes.length === 1, "Edit did not save");
    assert(writes[0].level === level && writes[0].projectPath === (level === "project" ? projectPath : undefined), "Edit moved the existing owner");
  }
  flushSync(() => root.render(null));
  hasProject = false;
  writes = [];
  records = [];
  useAppStore.setState({ workspace: null });
  flushSync(() => root.render(<AgentMcpPage />));
  click([...document.querySelectorAll('.agent-capability-segment button[role="radio"]')]
    .find((node) => node.textContent.trim().startsWith(i18n.t("settings.capabilityFilterProject"))));
  assert(button(i18n.t("settings.mcpMarket.browse")).disabled, "Project market requires a project");
  flushSync(() => root.render(<><McpMarketPanel level="project" installedIds={[]} onBack={() => {}} onInstalled={() => {}} /><ToastHost /></>));
  await until(marketAction, "Market guard fixture missing");
  click(marketAction());
  click(document.querySelector('[role="dialog"] .ext-sheet-actions button.mcpm-install:not(.is-ghost)'));
  await until(() => [...document.querySelectorAll(".toast-message")]
    .some((node) => node.textContent === i18n.t("settings.selectProjectFirst")), "Missing project must report an error");
  assert(writes.length === 0, "Missing project must never save globally");
  return { results, missingProjectBlocked: true };
};
`;

test("MCP market installation follows the selected project under All and explicit filters", {
  timeout: 60_000,
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-mcp-market-owner-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "true" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
        i18next: join(root, "apps/desktop/node_modules/i18next"),
        "react-i18next": join(root, "apps/desktop/node_modules/react-i18next"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    const result = await win.webContents.executeJavaScript("window.mcpMarketOwnerProbe()");
    console.log("MCP_MARKET_OWNER " + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output);
    const line = output.split(/\r?\n/).find((line) => line.startsWith("MCP_MARKET_OWNER "));
    assert(line, output);
    const result = JSON.parse(line.slice("MCP_MARKET_OWNER ".length));
    assert.equal(result.results.length, 6);
    assert.equal(result.missingProjectBlocked, true);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
