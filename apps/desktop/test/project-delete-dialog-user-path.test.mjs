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
import { ProjectDeleteDialog } from "../../apps/desktop/src/components/ProjectDeleteDialog";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

await i18n.use(initReactI18next).init({ lng: "en", keySeparator: false,
  resources: { en: { translation: flattenCatalog(catalogs.en) } },
  interpolation: { escapeValue: false } });
window.piDesktop = { platform: "darwin", on() { return () => {}; },
  invoke() { throw new Error("Unexpected IPC in project-delete dialog test"); } };
const deleteCalls = [];
let closeCount = 0;
let deletedCount = 0;
useAppStore.setState({
  deleteProject: async (path) => { deleteCalls.push(path); },
  abortSession: async () => { throw new Error("No running sessions expected"); },
});
function Surface() {
  const [open, setOpen] = React.useState(true);
  return open ? React.createElement(ProjectDeleteDialog, {
    project: { name: "Fixture project", path: "/fixture/project", sessionCount: 0 },
    runningSessionIds: [],
    onClose() { closeCount += 1; setOpen(false); },
    onDeleted() { deletedCount += 1; setOpen(false); },
    onError(error) { throw error; },
  }) : React.createElement("button", { onClick: () => setOpen(true) }, "Open delete dialog");
}
const rootNode = createRoot(document.getElementById("root"));
flushSync(() => rootNode.render(React.createElement(Surface)));
const frame = () => new Promise(requestAnimationFrame);
async function settle() { await frame(); await frame(); }
function check(condition, message) { if (!condition) throw new Error(message); }
async function until(predicate, message) {
  for (let n = 0; n < 120; n += 1) {
    if (predicate()) return;
    await frame();
  }
  throw new Error(message + " body=" + document.body.textContent);
}
window.projectDeleteProbe = async () => {
  await settle();
  check(document.querySelector('[role="dialog"]'), "confirmation dialog did not render");
  flushSync(() => document.querySelector(".project-instructions-dialog-close").click());
  await settle();
  check(closeCount === 1, "X did not dismiss the dialog");
  check(deleteCalls.length === 0, "X invoked project deletion");
  check(!document.querySelector('[role="dialog"]'), "X left the dialog open");

  flushSync(() => [...document.querySelectorAll("button")]
    .find((button) => button.textContent.trim() === "Open delete dialog").click());
  await settle();
  check(document.querySelector('[role="dialog"]'), "dialog did not reopen");
  flushSync(() => document.querySelector(".project-delete-dialog-confirm").click());
  await until(() => deletedCount === 1, "confirmation did not complete");
  await settle();
  check(deleteCalls.length === 1 && deleteCalls[0] === "/fixture/project",
    "explicit confirmation did not delete exactly once");
  check(!document.querySelector('[role="dialog"]'), "confirmed dialog stayed open");
  flushSync(() => rootNode.unmount());
  return { passed: true, deleteCalls };
};
`;

test("project-delete dialog X cancels and explicit confirmation deletes", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
}, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-project-delete-ui-"));
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
      '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
    await writeFile(join(temp, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 640, height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, "index.html"));
    console.log("PROJECT_DELETE_PROBE " + JSON.stringify(await win.webContents.executeJavaScript("window.projectDeleteProbe()")));
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
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
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
    const line = output.split(/\r?\n/).find((item) => item.startsWith("PROJECT_DELETE_PROBE "));
    assert.ok(line, output.slice(-6000));
    assert.deepEqual(JSON.parse(line.slice("PROJECT_DELETE_PROBE ".length)), {
      passed: true,
      deleteCalls: ["/fixture/project"],
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
