/**
 * Cost in the composer context inspector and the per-turn capsule, driven
 * through the real components, store, and English catalog in Electron. Only
 * the host rollup read (`api.getSessionUsageCost`) is stubbed, with deferred
 * answers so loading, refresh, and session switches are observable.
 */
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
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { ContextUsageInspector } from "../../apps/desktop/src/components/ContextUsageInspector";
import { TurnUsageCapsule } from "../../apps/desktop/src/features/chat/transcript/TurnUsageCapsule";
import { api } from "../../apps/desktop/src/lib/api";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

const calls = [];
api.getSessionUsageCost = (sessionId) => new Promise((resolve, reject) => {
  calls.push({ sessionId, resolve, reject });
});

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });

const now = new Date().toISOString();
const session = (id) => ({ id, title: id, createdAt: now, updatedAt: now });
useAppStore.setState({
  activeSessionId: "s1",
  sessions: [session("s1"), session("s2")],
  messages: [],
  providers: [
    { id: "api", name: "API", vendorKey: "openai", authKind: "api_key", models: [] },
    { id: "max", name: "Max", vendorKey: "anthropic", authKind: "oauth", models: [] },
  ],
});

const usage = (providerId, costStatus, total, tokens = 12) => ({
  operationId: providerId + tokens, providerId, costStatus, aggregation: "operation",
  inputTokens: tokens - 2, outputTokens: 2, totalTokens: tokens,
  cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
});
const bucket = (providerId, total, priced, reported, unpriced) =>
  ({ providerId, total, pricedRequests: priced, reportedRequests: reported, unpricedRequests: unpriced });

const rootNode = createRoot(document.getElementById("root"));
const settle = async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await new Promise((resolve) => setTimeout(resolve, 20));
};
const cells = () => Object.fromEntries([...document.querySelectorAll(".context-inspector-cost > div")]
  .map((row) => [row.querySelector("span").textContent, row.querySelector("strong").textContent]));
function check(condition, message) {
  if (!condition) throw new Error(message + " cells=" + JSON.stringify(cells()) + " calls=" + calls.length);
}
async function until(predicate, message) {
  for (let n = 0; n < 300; n += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  check(false, message);
}
const inspector = (turnUsage) => <ContextUsageInspector usage={turnUsage} turnUsage={turnUsage}
  contextWindow={128000} tools={[]} />;

window.usageCostProbe = async () => {
  // Opening the inspector shows the turn at once and the session once the host answers.
  const first = usage("api", "estimated", 0.042);
  flushSync(() => rootNode.render(inspector(first)));
  check(!document.querySelector(".context-inspector-cost"), "closed inspector shows no cost");
  check(calls.length === 0, "closed inspector must not read the host rollup");
  document.querySelector(".context-inspector-trigger").click();
  await until(() => cells()["Turn cost"] === "≈$0.042", "turn cost missing");
  check(cells()["Session total"] === "…", "session total should be loading");
  check(calls.length === 1 && calls[0].sessionId === "s1", "one rollup read for s1");
  calls[0].resolve({ sessionId: "s1", turnCount: 2, requestCount: 4, providers: [bucket("api", 1.25, 3, 3, 1)] });
  await until(() => cells()["Session total"] === "≥$1.25", "session lower bound missing");

  // Another billed request refreshes in place; the old figure stays until then.
  flushSync(() => rootNode.render(inspector(usage("api", "reported", 0.05, 20))));
  await until(() => calls.length === 2, "a new request did not refresh the rollup");
  check(cells()["Turn cost"] === "$0.05", "provider-billed turn cost");
  check(cells()["Session total"] === "≥$1.25", "refresh must not flash a spinner");
  calls[1].resolve({ sessionId: "s1", turnCount: 2, requestCount: 4, providers: [bucket("api", 1.5, 4, 4, 0)] });
  await until(() => cells()["Session total"] === "$1.50", "refreshed session total missing");

  // A session switch never shows the previous session's spend, and a late s1 answer is dropped.
  flushSync(() => rootNode.render(inspector(usage("api", "reported", 0.07, 30))));
  await until(() => calls.length === 3, "third read");
  flushSync(() => useAppStore.setState({ activeSessionId: "s2" }));
  flushSync(() => rootNode.render(inspector(usage("max", "estimated", 0.3, 40))));
  await until(() => calls.at(-1).sessionId === "s2", "s2 was not read");
  check(cells()["Session total"] === "…", "s2 must not show s1's total");
  calls[2].resolve({ sessionId: "s1", turnCount: 9, requestCount: 9, providers: [bucket("api", 99, 9, 9, 0)] });
  await settle();
  check(cells()["Session total"] === "…", "a late s1 answer leaked into s2");
  check(cells()["Turn cost"] === "Subscription", "subscription turn is named");
  calls.at(-1).resolve({ sessionId: "s2", turnCount: 1, requestCount: 1, providers: [bucket("max", 0.3, 1, 0, 0)] });
  await until(() => cells()["Session total"] === "Subscription", "subscription session total");
  const help = document.querySelector(".context-inspector-cost strong").getAttribute("title");
  check(/About \$0\.30 at API prices/.test(help), "subscription help: " + help);

  // The capsule carries a billed turn's price inline; subscription turns stay quiet.
  flushSync(() => rootNode.render(<>
    <div id="billed"><TurnUsageCapsule usage={usage("api", "estimated", 0.042)} throughput={50} /></div>
    <div id="sub"><TurnUsageCapsule usage={usage("max", "estimated", 0.5)} throughput={50} /></div>
  </>));
  await settle();
  const billed = document.querySelector("#billed .turn-usage-capsule");
  check(billed.querySelector(".turn-usage-cost-value")?.textContent === "≈$0.042", "capsule price missing");
  check(billed.getAttribute("aria-label").endsWith("Cost ≈$0.042"), "capsule aria lacks the price");
  check(!document.querySelector("#sub .turn-usage-cost-value"), "subscription turn must not show a price inline");
  billed.click();
  await until(() => document.querySelector(".turn-usage-cost strong")?.textContent === "≈$0.042", "popover cost row");
  const note = document.querySelector(".turn-usage-cost-help")?.textContent;
  check(note === "Estimated from the model's list prices.", "popover explanation: " + note);

  flushSync(() => rootNode.unmount());
  return { passed: true };
};
`;

test("cost shows per turn and per session, refreshes in place, and never crosses sessions", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-usage-cost-ui-"));
  try {
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"),
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
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
    await writeFile(join(temp, "index.html"),
      '<!doctype html><meta charset="utf-8"><div class="main-pane"><div id="root"></div></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      offscreen: process.platform === "win32" } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("USAGE_COST_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.usageCostProbe()")));
    app.exit(0);
  } catch (error) { console.error(error?.stack ?? error); app.exit(1); }
});`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      clearTimeout(timer);
    }
    assert.equal(code, 0, output.slice(-6000));
    const line = output.split(/\r?\n/).find((item) => item.startsWith("USAGE_COST_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.equal(JSON.parse(line.slice("USAGE_COST_PROBE ".length)).passed, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
