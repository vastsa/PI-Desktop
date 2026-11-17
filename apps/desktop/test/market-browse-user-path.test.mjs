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
 * The marketplace browse path as a user drives it: open the tab, scroll to the
 * end so the next pages load on their own, re-order, filter by category, retry
 * a page that failed, then type a search — and an answer for something the user
 * has since left (a first page or a next page) must never land in the list.
 *
 * The real Extensions page runs in a sandboxed Electron renderer. Only the
 * preload bridge is stubbed: `market.browse` is answered by a small fake
 * center that pages sixty plugins, so every request the page sends is the
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

const catalog = Array.from({ length: 60 }, (_, i) => ({
  id: "acme.plugin-" + String(i + 1).padStart(2, "0"),
  name: "Plugin " + (i + 1),
  description: "Fixture plugin " + (i + 1),
  author: "acme",
  latestVersion: "1.0.0",
  updatedAt: "2026-01-01T00:00:00Z",
  categories: [i % 5 === 0 ? "writing" : "tools"],
  permissionSummary: [],
  installable: true,
  downloads: 100 - i,
}));
const labels = { writing: { en: "Writing", "zh-CN": "写作与文档" }, tools: { en: "Tools", "zh-CN": "工具" } };
const browseCalls = [];
let hold = null;
let failNext = null;
function answer(input) {
  const q = (input.query || "").toLowerCase();
  const matches = catalog.filter((p) => !q || p.name.toLowerCase().includes(q));
  const counts = new Map();
  for (const p of matches) for (const c of p.categories) counts.set(c, (counts.get(c) || 0) + 1);
  const filtered = matches.filter((p) => !input.category || p.categories.includes(input.category));
  if (input.sort === "popular") filtered.sort((a, b) => b.downloads - a.downloads);
  else if (input.sort === "name") filtered.sort((a, b) => a.name.localeCompare(b.name));
  const size = input.pageSize || 24;
  const page = input.page || 1;
  return {
    plugins: filtered.slice((page - 1) * size, page * size),
    total: filtered.length, page, pageSize: size, pageCount: Math.ceil(filtered.length / size),
    sort: input.sort || "recommended",
    categories: [...counts].map(([id, count]) => ({ id, name: labels[id].en, count })),
    source: "remote", providerId: "official", sourceUrl: "https://center.invalid/catalog.json",
  };
}
window.piDesktop = { platform: "darwin", channels: IPC,
  on() { return () => {}; },
  async invoke(channel, input) {
    let data;
    if (channel === IPC.invoke.marketBrowse) {
      browseCalls.push(JSON.parse(JSON.stringify(input)));
      if (hold && hold.match(input)) { const gate = hold; hold = null; await gate.promise; }
      if (failNext && failNext(input)) { failNext = null; return { ok: false, error: { code: "PLUGIN_NETWORK", message: "center unreachable" } }; }
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
  // Electron competes with the rest of the suite for the machine; a page that
  // is slow to settle is not a failure.
  const end = performance.now() + 15000;
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

const scrollEnd = async () => {
  const end = document.querySelector(".plugins-load-more");
  check(end, "end of list missing");
  end.scrollIntoView({ block: "end" });
  await frame();
};
const loaded = () => document.querySelector(".plugins-load-more .plugins-result-count")?.textContent ?? "";
const gate = (match) => { let release; hold = { match, promise: new Promise((r) => { release = r; }) }; return () => release(); };
const pages = (filter) => browseCalls.filter(filter).map((c) => c.page);

window.marketProbe = async () => {
  await until(() => cards().length >= 24 && settled(), "first page did not render");
  const first = browseCalls[0];
  check(first.page === 1 && first.pageSize === 24 && first.sort === "recommended", "first request " + JSON.stringify(first));
  check(Number.isInteger(first.seed) && first.seed > 0, "no session seed");
  check(document.body.textContent.includes(label("browseTotal", { count: 60 })), "total missing");
  check(!document.querySelector(".plugins-pager"), "a pager must not render");

  // Scrolling to the end loads the remaining pages on its own, in order.
  for (let i = 0; i < 4 && cards().length < 60; i++) {
    await scrollEnd();
    await until(() => !document.querySelector(".plugins-load-more button[disabled]"), "next page did not settle");
  }
  await until(() => cards().length === 60, "pages did not append: " + cards().length);
  check(new Set(cards()).size === 60, "a plugin appeared twice");
  check(pages((c) => c.sort === "recommended").join() === "1,2,3", "pages " + pages((c) => c.sort === "recommended"));
  check(browseCalls.every((c) => c.seed === first.seed), "seed changed while scrolling");
  check(loaded() === label("loadedCount", { count: 60, total: 60 }), "loaded count " + loaded());
  check(!document.querySelector(".plugins-load-more button"), "load more must leave at the end");

  // A next page still loading when the sort changes must not join the new list.
  const releaseNamePage = gate((c) => c.sort === "name" && c.page === 2);
  await click(byText(".plugins-sort-btn", label("sortName")), "name sort missing");
  await until(() => lastCall().sort === "name" && settled(), "name sort not requested");
  await scrollEnd();
  await until(() => browseCalls.some((c) => c.sort === "name" && c.page === 2), "name page two not requested");
  await click(byText(".plugins-sort-btn", label("sortPopular")), "popular sort missing");
  await until(() => lastCall().sort === "popular" && lastCall().page === 1 && settled(), "popular not requested");
  check(lastCall().page === 1 || browseCalls.at(-2)?.page === 1, "sorting must restart the list");
  // Popular is Plugin 1, 2, 3… in order; any name-sorted card from the stale
  // page would break that run.
  const popularRun = () => cards().every((name, i) => name === "Plugin " + (i + 1));
  releaseNamePage();
  await new Promise((r) => setTimeout(r, 150));
  await frame();
  check(popularRun(), "a stale next page joined the new list: " + cards().slice(0, 30).join(","));

  // A failed page pauses automatic loading until the user retries.
  failNext = (c) => c.sort === "popular" && c.page === 2;
  await scrollEnd();
  const retry = () => byText(".plugins-load-more button", label("loadMoreRetry"));
  await until(() => retry(), "retry did not appear");
  const before = browseCalls.length;
  await scrollEnd();
  await new Promise((r) => setTimeout(r, 100));
  check(browseCalls.length === before, "a failed page must not be retried on its own");
  await click(retry(), "retry unavailable");
  await until(() => cards().length >= 48, "retry did not load the page");

  await click(byText(".plugins-sort-btn", label("sortRecommended")), "recommended missing");
  const writing = [...document.querySelectorAll(".plugins-filter")].find((n) => n.textContent.startsWith("Writing"));
  check(writing, "the chip must show the label, not the id");
  check(writing?.querySelector(".plugins-filter-count")?.textContent === "12", "category count missing");
  await click(writing, "writing chip missing");
  // The chip shows "Writing"; the filter carries the id it stands for.
  await until(() => lastCall().category === "writing" && cards().length === 12 && settled(), "category not applied");
  await click([...document.querySelectorAll(".plugins-filter")].find((n) => n.textContent.trim() === label("categoryAll")), "all chip missing");
  await until(() => lastCall().category === "" && settled(), "category not cleared");

  // A slow first page for an earlier search must not land over the latest one.
  const releaseSearch = gate((c) => c.query === "plugin 1");
  await type("plugin 1");
  await until(() => lastCall().query === "plugin 1", "first search not sent");
  await type("plugin 2");
  await until(() => lastCall().query === "plugin 2" && settled(), "second search did not settle");
  const latest = cards().join(",");
  releaseSearch();
  await new Promise((r) => setTimeout(r, 100));
  await frame();
  check(cards().join(",") === latest, "stale search replaced the latest: " + cards().join(","));
  check(cards().includes("Plugin 2") && cards().includes("Plugin 20") && !cards().includes("Plugin 1"), "wrong results " + latest);
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
  const win = new BrowserWindow({ show: false, width: 1100, height: 700,
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
