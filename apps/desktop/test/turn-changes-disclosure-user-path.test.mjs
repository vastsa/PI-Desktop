import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { TurnChangesCard } from "../../apps/desktop/src/features/chat/transcript/TurnChangesCard";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { SlotSessionProvider } from "../../apps/desktop/src/plugins/renderer-slots/use-slots";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { currentReviewFocusRequest } from "../../apps/desktop/src/lib/review-focus-request";

await i18n.use(initReactI18next).init({ lng: "en", resources: { en: { translation: catalogs.en } } });
window.piDesktop = { platform: "darwin", channels: IPC,
  invoke: async () => ({ ok: true, data: undefined }), on: () => () => {} };
useAppStore.setState({ activeSessionId: "session-a", workPanelTabs: [], activeWorkPanelTabId: null });
const view = createRoot(document.getElementById("root"));
const tools = Array.from({ length: 15 }, (_, index) => ({
  id: "edit-" + index, role: "tool", content: "", status: "complete", createdAt: "2026-10-28T00:00:00Z",
  toolName: "Edit", toolStatus: "success", toolResult: { details: { root: "workspace", review: {
    version: 1, snapshotId: "snap-" + index, messageId: "edit-" + index,
    path: "src/dir" + (index % 3) + "/file" + index + ".ts", operation: "edit", status: "modified",
    state: index === 1 ? "rolledBack" : "active", additions: 2, deletions: 1, hunks: [], reversible: true,
  } } },
}));
const otherTools = [{ ...tools[0], id: "other-turn-tool" }];
const render = () => flushSync(() => view.render(
  <SlotSessionProvider sessionId="session-a">
    <TranscriptDisclosureProvider sessionId="session-a">
      <TurnChangesCard tools={tools} /><TurnChangesCard tools={otherTools} />
    </TranscriptDisclosureProvider>
  </SlotSessionProvider>));
const frame = () => new Promise(requestAnimationFrame);
const settle = async () => { await frame(); await frame(); };
function check(condition, message) { if (!condition) throw new Error(message); }
function heading(index = 0) { return document.querySelectorAll(".turn-changes-head")[index]; }
function content(index = 0) { return document.getElementById(heading(index).getAttribute("aria-controls")); }
function expanded(expected) {
  check(heading().getAttribute("aria-expanded") === String(expected), "Disclosure state is incorrect");
  check(content().hidden === !expected, "Disclosure accessibility state and body visibility disagree");
  check(content().querySelector(".turn-changes-row").getClientRects().length === (expected ? 1 : 0),
    "Collapsed file rows still occupy space");
}
window.turnChangesProbe = async (stage) => {
  if (stage === "pointer") {
    render(); await settle();
    expanded(false);
    const hiddenRow = content().querySelector(".turn-changes-row");
    hiddenRow.focus();
    check(document.activeElement !== hiddenRow, "Collapsed file row can receive keyboard focus");
    check(heading(1).getAttribute("aria-expanded") === "false", "Another turn starts expanded");
    check(content().querySelector(".turn-changes-view-all").getClientRects().length === 0,
      "View all action escaped the collapsed body");
    const totals = heading().textContent;
    check(totals.includes("15 files") && totals.includes("3 dirs") && totals.includes("+30") && totals.includes("−15"),
      "Collapsed heading lost summary counts");
    flushSync(() => heading().click()); await settle();
    expanded(true);
    check(useAppStore.getState().activeWorkPanelTabId === null, "Expanding opened Review");
    check(heading(1).getAttribute("aria-expanded") === "false", "Expanding one turn expands another");
    check(content().querySelectorAll(".turn-changes-row").length === 12, "Expanded file list lost its row limit");
    check(content().querySelector('[data-rolled-back="true"]'), "Rolled-back file state was lost");
    render(); await settle(); expanded(true);
    flushSync(() => content().querySelector(".turn-changes-row").click());
    check(currentReviewFocusRequest().snapshotIds.join() === "snap-0" && currentReviewFocusRequest().expand,
      "Expanded file row did not request its Review changes");
    const state = useAppStore.getState();
    check(state.workPanelTabs.find(tab => tab.id === state.activeWorkPanelTabId)?.kind === "review",
      "File row did not open the originating session's Review tab");
    flushSync(() => content().querySelector(".turn-changes-view-all").click());
    check(currentReviewFocusRequest().snapshotIds.length === 15 && !currentReviewFocusRequest().expand,
      "View all no longer opens every recorded change");
    flushSync(() => heading().click()); await settle(); expanded(false);
    check(heading().textContent === totals, "Toggling changed the summary counts");
    heading().focus();
  } else {
    await settle();
    expanded(stage === "keyboard-open");
    check(document.activeElement === heading(), "Keyboard activation lost disclosure focus");
    if (stage === "keyboard-close") flushSync(() => view.unmount());
  }
  return { passed: true, stage };
};
`;

test("turn changes start collapsed, toggle independently, and keep Review actions", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-turn-changes-ui-"));
  try {
    const styles = await Promise.all(["tokens", "base", "ui-kit", "turn-changes"].map((name) =>
      readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8")));
    await writeFile(join(temp, "style.css"), styles.join("\n"));
    await build({
      stdin: { contents: fixture, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"', "import.meta.env": '{"DEV":false,"MODE":"production"}' },
      loader: { ".css": "empty" },
      alias: {
        "@pi-desktop/i18n": join(root, "packages/i18n/src"),
        "@pi-desktop/shared": join(root, "packages/shared/src"),
        react: join(root, "apps/desktop/node_modules/react"),
        "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
      },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><title>Turn changes disclosure regression</title><link rel="stylesheet" href="style.css"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("TURN_CHANGES " + JSON.stringify(await win.webContents.executeJavaScript('window.turnChangesProbe("pointer")')));
    win.webContents.focus();
    for (const [keyCode, stage] of [["Enter", "keyboard-open"], ["Space", "keyboard-close"]]) {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode });
      win.webContents.sendInputEvent({ type: "char", keyCode: keyCode === "Enter" ? "\\r" : " " });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode });
      console.log("TURN_CHANGES " + JSON.stringify(await win.webContents.executeJavaScript("window.turnChangesProbe(" + JSON.stringify(stage) + ")")));
    }
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally { clearTimeout(timeout); }
    assert.equal(code, 0, output.slice(-6000));
    const results = output.split(/\r?\n/).filter(line => line.startsWith("TURN_CHANGES "))
      .map(line => JSON.parse(line.slice("TURN_CHANGES ".length)));
    assert.deepEqual(results, ["pointer", "keyboard-open", "keyboard-close"].map(stage => ({ passed: true, stage })));
  } finally { await rm(temp, { recursive: true, force: true }); }
});
