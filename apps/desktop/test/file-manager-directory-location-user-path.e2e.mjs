import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

/**
 * A host location that names a directory must browse it, not fail as a file
 * read (issue #2113). The journey runs the production view against the real
 * bundled plugin main process over the real bridge shapes: the preload only
 * supplies the `pi` environment the plugin expects, records every channel
 * call, and forwards the `fm.*` channels to the actual `onPanelInvoke`.
 *
 * Four host requests are exercised against real files on disk: a directory in
 * the primary root (expand, select, list, no read), an ordinary file (the
 * preview contract is unchanged), a directory in a sibling root of the same
 * project group (root switch, then browse), and a directory outside the
 * managed roots (scratch) which keeps its honest localized rejection.
 *
 * Evidence-first: a scenario that never reaches its expectation does not
 * abort the journey with a bare timeout — the probe dumps the page state and
 * the recorded channel log so the failure carries its own diagnosis.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const viewEntry =
  process.env.PI_FILE_MANAGER_VIEW ??
  join(root, "apps/desktop/resources/plugins/pi.file-manager/views/index.html");
const electronBinary =
  process.env.PI_DESKTOP_ELECTRON_BIN ?? resolveElectronBinary(root).electronBinary;

const mainFixture = String.raw`
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const viewEntry = process.env.PI_FILE_MANAGER_VIEW;
app.setPath("userData", path.join(__dirname, "profile"));

const WAIT_MS = 15000;

async function waitForState(window, expression) {
  const deadline = Date.now() + WAIT_MS;
  let lastState = null;
  for (;;) {
    lastState = await readState(window);
    let met = false;
    try {
      met = await window.webContents.executeJavaScript("Boolean(" + expression + ")");
    } catch {
      met = false;
    }
    if (met) return { met: true, state: lastState };
    if (Date.now() > deadline) return { met: false, state: lastState };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function readState(window) {
  return window.webContents.executeJavaScript("(() => {" +
    "const selected = document.querySelector('.tree-row[aria-selected=\"true\"]');" +
    "const alert = document.querySelector('[role=\"alert\"]');" +
    "let log = null;" +
    "try { log = window.__fixtureLog ? window.__fixtureLog() : null; } catch {}" +
    "return {" +
      "bridge: Boolean(window.pluginBridge)," +
      "selectedPath: selected?.getAttribute('data-path') ?? null," +
      "selectedExpanded: selected?.getAttribute('aria-expanded') ?? null," +
      "alertText: alert?.textContent ?? null," +
      "editorOpen: Boolean(document.querySelector('.cm-content'))," +
      "treeRows: [...document.querySelectorAll('.tree-row')].map((row) => row.getAttribute('data-path'))," +
      "bodySample: (document.body?.textContent ?? '').slice(0, 300)," +
      "fixtureLog: log," +
    "};" +
  "})()");
}

// One Electron window per scenario; the location rides the entry URL query,
// the same transport a first click uses.
async function open(fixtures, location) {
  const window = new BrowserWindow({
    show: false,
    width: 1000,
    height: 700,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(fixtures.dir, "preload.cjs"),
      additionalArguments: [
        "--fixture-ws=" + fixtures.workspace,
        "--fixture-scratch=" + fixtures.scratch,
      ],
    },
  });
  const viewUrl = pathToFileURL(viewEntry);
  viewUrl.searchParams.set("piViewOpen", location);
  await window.loadURL(viewUrl.href).catch((error) => {
    throw new Error("load failed for " + location + ": " + error.message);
  });
  return window;
}

app.whenReady().then(async () => {
  const fixtures = {
    dir: path.join(__dirname),
    workspace: process.env.PI_FIXTURE_WORKSPACE,
    scratch: process.env.PI_FIXTURE_SCRATCH,
  };
  const report = {};
  try {
    // 1. A directory in the primary root: expanded, selected, listed, no read.
    const directoryWindow = await open(fixtures, "examples");
    const directory = await waitForState(directoryWindow,
      "document.querySelector('.tree-row[data-path=\"examples/child.txt\"]') !== null");
    report.directory = directory;
    directoryWindow.destroy();

    // 2. An ordinary file: the preview contract is unchanged.
    const fileWindow = await open(fixtures, "test.ts");
    const file = await waitForState(fileWindow,
      "document.querySelector('.cm-content')?.textContent.includes('visible')");
    report.file = file;
    fileWindow.destroy();

    // 3. A directory in the sibling root, named by its absolute path: switch
    //    root, then browse.
    const siblingWindow = await open(fixtures, path.join(fixtures.workspace, "sibling", "docs"));
    const sibling = await waitForState(siblingWindow,
      "document.querySelector('.tree-row[data-path=\"docs/guide.md\"]') !== null");
    report.sibling = sibling;
    siblingWindow.destroy();

    // 4. A scratch directory outside the managed roots: honest localized
    //    rejection, no editor, no crash.
    const scratchWindow = await open(fixtures, path.join(fixtures.scratch, "run"));
    const scratch = await waitForState(scratchWindow,
      "document.querySelector('[role=\"alert\"]') !== null");
    report.scratch = scratch;
    scratchWindow.destroy();

    console.log("FILE_MANAGER_DIRECTORY_PROBE " + JSON.stringify({ ok: true, report }));
    app.exit(0);
  } catch (error) {
    console.error(
      "FILE_MANAGER_DIRECTORY_PROBE " +
        JSON.stringify({ ok: false, error: String(error?.stack ?? error), report }),
    );
    app.exit(1);
  }
});
`;

function assertDirectoryState(state) {
  assert.equal(state.met, true, "child row never appeared; state: " + describe(state));
  assert.equal(state.state.selectedPath, "examples");
  assert.equal(state.state.selectedExpanded, "true");
  assert.equal(state.state.editorOpen, false, "a directory must not dispatch a file read");
  assert.equal(state.state.alertText, null, "no failure banner for a directory location");
  assert.ok(state.state.treeRows.includes("examples/child.txt"), state.state.treeRows.join(","));
}

function assertFileState(state) {
  assert.equal(state.met, true, "editor content never appeared; state: " + describe(state));
  assert.equal(state.state.selectedPath, "test.ts");
  assert.equal(state.state.editorOpen, true, "the file preview contract is unchanged");
  assert.equal(state.state.alertText, null);
}

function assertSiblingState(state) {
  assert.equal(state.met, true, "sibling rows never appeared; state: " + describe(state));
  assert.equal(state.state.selectedPath, "docs");
  assert.equal(state.state.selectedExpanded, "true");
  assert.equal(state.state.editorOpen, false);
  assert.equal(state.state.alertText, null);
  assert.ok(state.state.treeRows.includes("docs/guide.md"), state.state.treeRows.join(","));
}

function assertScratchState(state) {
  assert.equal(state.met, true, "rejection banner never appeared; state: " + describe(state));
  assert.equal(state.state.editorOpen, false);
  assert.match(
    state.state.alertText,
    /That path is a directory/,
    "the scratch rejection must be the localized directory message",
  );
}

function describe(state) {
  return JSON.stringify({
    bridge: state.state?.bridge,
    selectedPath: state.state?.selectedPath,
    alertText: state.state?.alertText,
    editorOpen: state.state?.editorOpen,
    treeRows: state.state?.treeRows,
    bodySample: state.state?.bodySample,
    fixtureLog: state.state?.fixtureLog,
  });
}

test(
  "host directory locations browse the File Manager instead of failing as file reads",
  {
    skip:
      process.platform === "linux" && !process.env.DISPLAY
        ? "Electron requires a display"
        : false,
  },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pi-file-manager-dir-"));
    try {
      // Workspace layout: primary root with a directory and a file; a sibling
      // root with its own directory; a scratch store outside the project.
      const workspace = join(temp, "project");
      const sibling = join(workspace, "sibling");
      const scratch = join(temp, "scratch");
      await mkdir(join(workspace, "examples"), { recursive: true });
      await writeFile(join(workspace, "examples", "child.txt"), "child\n");
      await writeFile(join(workspace, "test.ts"), "const visible = true;\n");
      await mkdir(join(sibling, "docs"), { recursive: true });
      await writeFile(join(sibling, "docs", "guide.md"), "# guide\n");
      await mkdir(join(scratch, "run"), { recursive: true });
      await writeFile(join(scratch, "run", "artifact.txt"), "artifact\n");

      // The preload requires the vendored plugin from the app resources; stage
      // a copy next to the workspace the fixture constructs (main.js only
      // requires node builtins, so a copy is self-contained and needs no
      // symlink privilege).
      const pluginStage = join(temp, "staged");
      await mkdir(join(pluginStage, "pi.file-manager"), { recursive: true });
      await copyFile(
        join(root, "apps/desktop/resources/plugins/pi.file-manager/main.js"),
        join(pluginStage, "pi.file-manager", "main.js"),
      );

      const preload = String.raw`
const { contextBridge } = require("electron");
const path = require("node:path");

const log = [];
const preloadError = (() => {
  try {
    const workspaceDir = process.argv.find((value) => value.startsWith("--fixture-ws="))?.slice("--fixture-ws=".length);
    const dataDir = path.join(workspaceDir, ".plugin-data");

    const workspace = {
      path: workspaceDir,
      name: "project",
      projectId: "fixture-project",
      roots: [
        { path: workspaceDir, name: "project", primary: true },
        { path: path.join(workspaceDir, "sibling"), name: "sibling", primary: false },
      ],
    };

    const plugin = require(path.join(workspaceDir, "..", "staged", "pi.file-manager", "main.js"));
    globalThis.pi = {
      workspace: { get: async () => workspace },
      plugin: {
        getDataPath: async () => dataDir,
        getSettings: async () => ({}),
        setSettings: async () => ({}),
      },
      // handleHello probes this with a bare typeof; an absent fs would throw
      // and turn the whole hello (root included) into a failure.
      fs: {},
    };

    contextBridge.exposeInMainWorld("pluginBridge", {
      async invoke(channel, payload = {}) {
        try {
          let result;
          switch (channel) {
            case "app.getAppearance":
              result = { base: "dark", locale: "en" };
              break;
            case "workspace.get":
              result = workspace;
              break;
            default:
              if (!channel.startsWith("fm.")) {
                throw new Error("Unexpected fixture channel: " + channel);
              }
              result = await plugin.onPanelInvoke(channel, { ...payload, workspacePath: workspaceDir });
          }
          log.push({ channel, ok: true, result: JSON.stringify(result).slice(0, 200) });
          return result;
        } catch (error) {
          log.push({ channel, ok: false, error: String(error).slice(0, 200) });
          throw error;
        }
      },
      on() {
        return () => {};
      },
    });
    contextBridge.exposeInMainWorld("__fixtureLog", () => log);
    return null;
  } catch (error) {
    return String(error?.stack ?? error);
  }
})();
contextBridge.exposeInMainWorld("__preloadError", () => preloadError);
`;

      await writeFile(join(temp, "preload.cjs"), preload);
      await writeFile(join(temp, "main.cjs"), mainFixture);

      const env = {
        ...process.env,
        PI_FILE_MANAGER_VIEW: viewEntry,
        PI_FIXTURE_WORKSPACE: workspace,
        PI_FIXTURE_SCRATCH: scratch,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electronBinary, [join(temp, "main.cjs")], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output += chunk;
        });
      }
      const timeout = setTimeout(() => child.kill("SIGKILL"), 150_000);
      let code;
      try {
        code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
      } finally {
        clearTimeout(timeout);
      }

      const line = output
        .split(/\r?\n/)
        .find((item) => item.startsWith("FILE_MANAGER_DIRECTORY_PROBE "));
      assert.ok(line, output.slice(-8000));
      assert.equal(code, 0, output.slice(-8000));
      const result = JSON.parse(line.slice("FILE_MANAGER_DIRECTORY_PROBE ".length));
      assert.equal(result.ok, true, output.slice(-8000));
      assertDirectoryState(result.report.directory);
      assertFileState(result.report.file);
      assertSiblingState(result.report.sibling);
      assertScratchState(result.report.scratch);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
