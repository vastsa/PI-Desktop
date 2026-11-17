import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";
import { loadStyles } from "./helpers/styles.mjs";

/*
 * The marketplace browse path as a user drives it: open the tab, page forward,
 * re-order, filter by category, then type a search — and a slow answer for an
 * earlier search must not replace the answer for the latest one.
 *
 * The real Extensions page runs in a sandboxed Electron renderer. Only the
 * preload bridge is stubbed: `market.browse` is answered by a small fake
 * center that pages thirty plugins, so every request the page sends is the
 * contract the host receives.
 */

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");

const fixture = String.raw`
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { PluginsPage } from "../../apps/desktop/src/pages/PluginsPage";
import { usePluginBrowseState } from "../../apps/desktop/src/features/plugins/browse-state";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } }, interpolation: { escapeValue: false } });
const label = (key, options) => i18n.t("plugins." + key, options);

const catalog = Array.from({ length: 30 }, (_, i) => ({
  id: "acme.plugin-" + String(i + 1).padStart(2, "0"),
  name: "Plugin " + (i + 1),
  description: "Fixture plugin " + (i + 1),
  author: "acme",
  latestVersion: "1.0.0",
  updatedAt: "2026-01-01T00:00:00Z",
  categories: [i % 5 === 0 ? "Writing" : "Tools"],
  permissionSummary: [],
  installable: true,
  downloads: 100 - i,
}));
const browseCalls = [];
const held = new Map();
function answer(input) {
  const q = (input.query || "").toLowerCase();
  const matches = catalog.filter((p) => !q || p.name.toLowerCase().includes(q));
  const counts = new Map();
  for (const p of matches) for (const c of p.categories) counts.set(c, (counts.get(c) || 0) + 1);
  const filtered = matches.filter((p) => !input.category || p.categories.includes(input.category));
  const size = input.pageSize || 24;
  const page = input.page || 1;
  return {
    plugins: filtered.slice((page - 1) * size, page * size),
    total: filtered.length, page, pageSize: size, pageCount: Math.ceil(filtered.length / size),
    sort: input.sort || "recommended",
    categories: [...counts].map(([id, count]) => ({ id, count })),
    source: "remote", providerId: "official", sourceUrl: "https://center.invalid/catalog.json",
  };
}
window.piDesktop = { platform: "darwin", channels: IPC,
  on() { return () => {}; },
  async invoke(channel, input) {
    let data;
    if (channel === IPC.invoke.marketBrowse) {
      browseCalls.push(JSON.parse(JSON.stringify(input)));
      const gate = held.get(input.query);
      if (gate) await gate.promise;
      data = answer(input);
    } else if (channel === IPC.invoke.listProjects) data = { projects: [] };
    else if (channel === IPC.invoke.marketCheckUpdates) data = { updates: [], plugins: [] };
    else if (channel === IPC.invoke.marketReviewSummaries) data = { summaries: {} };
    else if (channel === IPC.invoke.marketReviewTickers) data = { tickers: {} };
    else if (channel === IPC.invoke.pluginServices) data = [];
    else if (channel === IPC.invoke.pluginList) data = { plugins: [] };
    else data = {};
    return { ok: true, data };
  },
};
usePluginBrowseState.setState({ tab: "market" });

const check = (value, message) => { if (!value) throw new Error(message); };
const frame = () => new Promise(requestAnimationFrame);
const until = async (condition, message) => {
  const end = performance.now() + 5000;
  while (!condition()) { if (performance.now() > end) throw new Error(message); await frame(); }
};
const cards = () => [...document.querySelectorAll(".plugins-card-name")].map((n) => n.textContent);
const lastCall = () => browseCalls.at(-1);
const byText = (selector, text) => [...document.querySelectorAll(selector)].find((n) => n.textContent.trim() === text);
const click = async (node, message) => { check(node && !node.disabled, message); flushSync(() => node.click()); await frame(); };
const type = async (value) => {
  const input = document.querySelector('input[aria-label="' + label("marketSearchPlaceholder") + '"]');
  check(input, "search field missing");
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await frame();
};
const settled = () => !document.querySelector("#plugins-panel-market[aria-busy]");

createRoot(document.getElementById("root")).render(React.createElement(PluginsPage));

window.marketProbe = async () => {
  await until(() => cards().length === 24 && settled(), "first page did not render");
  const first = browseCalls[0];
  check(first.page === 1 && first.pageSize === 24 && first.sort === "recommended", "first request " + JSON.stringify(first));
  check(Number.isInteger(first.seed) && first.seed > 0, "no session seed");
  check(document.body.textContent.includes(label("browseTotal", { count: 30 })), "total missing");
  check(document.querySelector('[aria-current="page"]')?.textContent === "1", "page one not current");

  await click(document.querySelector('button[aria-label="' + label("pageNext") + '"]'), "next page unavailable");
  await until(() => cards().length === 6 && settled(), "second page did not render");
  check(lastCall().page === 2 && lastCall().seed === first.seed, "page two request " + JSON.stringify(lastCall()));
  check(document.querySelector('[aria-current="page"]')?.textContent === "2", "page two not current");

  await click(byText(".plugins-sort-btn", label("sortPopular")), "popular sort missing");
  await until(() => lastCall().sort === "popular" && settled(), "sort not requested");
  check(lastCall().page === 1, "sorting must return to page one");
  check(byText(".plugins-sort-btn", label("sortPopular")).getAttribute("aria-checked") === "true", "sort not selected");

  const writing = [...document.querySelectorAll(".plugins-filter")].find((n) => n.textContent.startsWith("Writing"));
  check(writing?.querySelector(".plugins-filter-count")?.textContent === "6", "category count missing");
  await click(writing, "writing chip missing");
  await until(() => lastCall().category === "Writing" && cards().length === 6 && settled(), "category not applied");
  check(!document.querySelector(".plugins-pager"), "one page must not show a pager");
  await click([...document.querySelectorAll(".plugins-filter")].find((n) => n.textContent.trim() === label("categoryAll")), "all chip missing");
  await until(() => lastCall().category === "" && settled(), "category not cleared");

  // A slow answer for an earlier search must not land over the latest one.
  let release;
  held.set("plugin 1", { promise: new Promise((resolve) => { release = resolve; }) });
  await type("plugin 1");
  await until(() => lastCall().query === "plugin 1", "first search not sent");
  await type("plugin 2");
  await until(() => lastCall().query === "plugin 2" && settled(), "second search did not settle");
  const latest = cards().join(",");
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await frame();
  check(cards().join(",") === latest, "stale search replaced the latest: " + cards().join(","));
  check(cards().includes("Plugin 2") && cards().includes("Plugin 20") && !cards().includes("Plugin 1"), "wrong results " + latest);
  check(lastCall().page === 1, "searching must return to page one");
  return { passed: true, requests: browseCalls.length };
};
`;

test("marketplace browse user path pages, sorts, filters and searches without stale answers", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "market-browse-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl" },
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
    await writeFile(join(temp, "styles.css"), (await loadStyles()).replace(/@theme(?: inline)?\s*\{/g, ":root {"));
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:"><link rel="stylesheet" href="styles.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow, session } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.log("RENDERER " + event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("MARKET_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.marketProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    } finally { clearTimeout(timer); }
    assert.equal(code, 0, output.slice(-6000));
    assert.match(output, /MARKET_PROBE \{"passed":true/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
