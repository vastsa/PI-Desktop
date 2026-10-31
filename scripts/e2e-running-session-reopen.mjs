/** #1912: a recreated Electron renderer restores live sidebar/session state. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const temp = await mkdtemp(join(tmpdir(), "pi-running-reopen-"));
try {
  await build({
    stdin: { resolveDir: root, loader: "tsx", contents: `
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import i18n from "i18next";
      import { initReactI18next } from "react-i18next";
      import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
      import { PROTOCOL_VERSION } from "@pi-desktop/shared";
      import { Sidebar } from "./apps/desktop/src/components/Sidebar";
      import { useAppStore } from "./apps/desktop/src/stores/app-store";
      import { api } from "./apps/desktop/src/lib/api";
      import { seedRunningSessionApi } from "./apps/desktop/test/helpers/session-running-fixture.mjs";
      await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en",
        resources: { en: { translation: flattenCatalog(catalogs.en) } },
        interpolation: { escapeValue: false } });
      const noop = () => {};
      const reactRoot = createRoot(document.getElementById("root"));
      window.runningSessionProbe = async (runningSessionIds) => {
        seedRunningSessionApi(api, PROTOCOL_VERSION, runningSessionIds);
        api.updatesGetState = async () => null;
        api.onUpdateState = () => noop;
        await useAppStore.getState().bootstrap();
        if (!useAppStore.getState().healthOk) throw new Error(useAppStore.getState().error);
        flushSync(() => reactRoot.render(<Sidebar onToggleSidebar={noop} sidebarToggleShortcut=""
          sidebarWidth={260} onWidthChange={noop} onWidthCommit={noop} onResizeCollapse={noop} />));
        const row = document.querySelector('[data-sidebar-session-row="running"]');
        if (!row) throw new Error("the restored session is missing from the sidebar");
        const badge = row.querySelector(".thread-item-status");
        const running = badge?.classList.contains("running") === true;
        const completed = badge?.classList.contains("completed") === true;
        row.querySelector(".thread-item-main").click();
        for (let frame = 0; frame < 120 && useAppStore.getState().activeSessionId !== "running"; frame++) {
          await new Promise(requestAnimationFrame);
        }
        const state = useAppStore.getState();
        return { running, completed, active: state.activeSessionId, isRunning: state.isRunning };
      };
    ` },
    outfile: join(temp, "renderer.js"),
    bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    loader: { ".png": "dataurl", ".gif": "dataurl", ".svg": "dataurl" },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await writeFile(join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="renderer.js"></script>');
  await writeFile(join(temp, "main.cjs"), `
    const { app, BrowserWindow } = require("electron");
    const path = require("node:path");
    app.setPath("userData", path.join(__dirname, "profile"));
    app.on("window-all-closed", () => {});
    app.whenReady().then(async () => {
      try {
        const results = [];
        for (const runningIds of [["running"], ["running"], []]) {
          const window = new BrowserWindow({ show: false, width: 900, height: 700,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
              backgroundThrottling: false, offscreen: process.platform === "win32" } });
          window.webContents.on("console-message", (event) => console.error(event.message));
          await window.loadFile(path.join(__dirname, "index.html"));
          results.push(await window.webContents.executeJavaScript(
            "window.runningSessionProbe(" + JSON.stringify(runningIds) + ")"));
          window.destroy();
        }
        console.log("RUNNING_REOPEN_PROBE " + JSON.stringify(results));
        app.exit(0);
      } catch (error) { console.error(error.stack || error); app.exit(1); }
    });
  `);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary, [join(temp, "main.cjs")], {
    env, stdio: ["ignore", "pipe", "pipe"],
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
  } finally { clearTimeout(timer); }
  assert.equal(code, 0, output.slice(-6000));
  const line = output.split(/\r?\n/).find((item) => item.startsWith("RUNNING_REOPEN_PROBE "));
  assert.ok(line, output.slice(-6000));
  const results = JSON.parse(line.slice("RUNNING_REOPEN_PROBE ".length));
  assert.deepEqual(results, [true, true, false].map((running) => ({
    running, completed: !running, active: "running", isRunning: running,
  })));
  console.log("RUNNING_REOPEN_PROBE " + JSON.stringify({ passed: true, results }));
} finally {
  await rm(temp, { recursive: true, force: true });
}
