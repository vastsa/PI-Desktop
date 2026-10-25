import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const viewEntry =
  process.env.PI_FILE_MANAGER_VIEW ??
  join(root, "apps/desktop/resources/plugins/pi.file-manager/views/index.html");
const electronBinary =
  process.env.PI_DESKTOP_ELECTRON_BIN ?? resolveElectronBinary(root).electronBinary;

const preloadFixture = String.raw`
const { contextBridge } = require("electron");

const themeArgument = process.argv.find((value) => value.startsWith("--fixture-theme="));
const theme = themeArgument?.split("=")[1] === "light" ? "light" : "dark";
const workspace = {
  path: "C:/fixture/project",
  name: "project",
  projectId: "fixture-project",
  roots: [{ path: "C:/fixture/project", name: "project", primary: true }],
};
const prefs = {
  splitRatio: 0.32,
  treeCollapsed: false,
  showIgnored: false,
  mdPreview: false,
  csvTable: true,
  jsonTree: false,
  tablePageSize: 1000,
  projectRoots: {},
};

contextBridge.exposeInMainWorld("pluginBridge", {
  async invoke(channel, payload = {}) {
    switch (channel) {
      case "app.getAppearance":
        return { base: theme, locale: "en" };
      case "workspace.get":
        return workspace;
      case "fm.hello":
        return {
          ok: true,
          root: workspace,
          limits: {
            maxReadBytes: 2 * 1024 * 1024,
            maxWriteBytes: 8 * 1024 * 1024,
            maxListEntries: 5000,
          },
          ignoreFiles: [],
          prefs,
        };
      case "fm.list":
        return {
          ok: true,
          path: payload.path ?? "",
          entries: payload.path
            ? []
            : [{
                name: "test.ts",
                path: "test.ts",
                isDirectory: false,
                size: 22,
                mtimeMs: 1,
                ignored: false,
                isSymlink: false,
                outside: false,
              }],
          truncated: false,
          ignoreActive: false,
        };
      case "fm.read":
        return {
          ok: true,
          kind: "text",
          path: payload.path,
          text: "const visible = true;\n",
          eol: "lf",
          bom: false,
          size: 22,
          mtimeMs: 1,
        };
      case "fm.prefs.set":
        return { ok: true, prefs: { ...prefs, ...(payload.partial ?? {}) } };
      default:
        throw new Error("Unexpected fixture channel: " + channel);
    }
  },
  on() {
    return () => {};
  },
});
`;

const mainFixture = String.raw`
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const viewEntry = process.env.PI_FILE_MANAGER_VIEW;
app.setPath("userData", path.join(__dirname, "profile"));

async function waitFor(window, expression) {
  const timeoutMessage = JSON.stringify("timed out: " + expression);
  await window.webContents.executeJavaScript(
    "new Promise((resolve, reject) => {" +
      "const deadline = Date.now() + 5000;" +
      "const poll = () => {" +
        "if (" + expression + ") resolve();" +
        "else if (Date.now() > deadline) reject(new Error(" + timeoutMessage + "));" +
        "else setTimeout(poll, 50);" +
      "}; poll();" +
    "})",
  );
}

const windows = [];

async function probe(theme) {
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: ["--fixture-theme=" + theme],
    },
  });
  windows.push(window);

  const viewUrl = pathToFileURL(viewEntry);
  viewUrl.searchParams.set("piViewOpen", "test.ts");
  await window.loadURL(viewUrl.href).catch((error) => {
    throw new Error(theme + " load failed: " + error.message);
  });
  await waitFor(window, "document.querySelector('.cm-content')?.textContent.includes('visible')");
  await window.webContents.executeJavaScript("document.querySelector('.cm-content').focus()");
  window.webContents.sendInputEvent({
    type: "keyDown",
    keyCode: "F",
    modifiers: [process.platform === "darwin" ? "meta" : "control"],
  });
  window.webContents.sendInputEvent({
    type: "keyUp",
    keyCode: "F",
    modifiers: [process.platform === "darwin" ? "meta" : "control"],
  });
  await waitFor(window, "document.querySelector('.cm-panel.cm-search .cm-textfield')");
  return await window.webContents.executeJavaScript("(() => {" +
    "const fields = [...document.querySelectorAll('.cm-panel.cm-search .cm-textfield')];" +
    "const buttons = [...document.querySelectorAll('.cm-panel.cm-search .cm-button')];" +
    "const styles = (element) => {" +
      "const style = getComputedStyle(element);" +
      "return {" +
        "color: style.color," +
        "backgroundColor: style.backgroundColor," +
        "backgroundImage: style.backgroundImage," +
      "};" +
    "};" +
    "return {" +
      "base: document.documentElement.dataset.base," +
      "fields: fields.map(styles)," +
      "buttons: buttons.map(styles)," +
    "};" +
  "})()");
}

app.whenReady().then(async () => {
  try {
    const result = { dark: await probe("dark"), light: await probe("light") };
    console.log("FILE_MANAGER_THEME_PROBE " + JSON.stringify({ ok: true, result }));
    app.exit(0);
  } catch (error) {
    console.error(
      "FILE_MANAGER_THEME_PROBE " +
        JSON.stringify({ ok: false, error: String(error?.stack ?? error) }),
    );
    app.exit(1);
  }
});
`;

function assertTheme(report, theme) {
  assert.equal(report.base, theme);
  assert.equal(report.fields.length, 2, "find and replace fields must both be themed");
  assert.ok(report.buttons.length >= 5, "search actions must be themed");

  const foreground = theme === "dark" ? "rgb(255, 255, 255)" : "rgb(26, 28, 31)";
  const fieldBackground = theme === "dark" ? "rgb(24, 24, 24)" : "rgb(255, 255, 255)";
  for (const field of report.fields) {
    assert.equal(field.color, foreground);
    assert.equal(field.backgroundColor, fieldBackground);
    assert.equal(field.backgroundImage, "none");
  }
  for (const button of report.buttons) {
    assert.equal(button.color, foreground);
    assert.equal(button.backgroundImage, "none");
    assert.notEqual(button.backgroundColor, "rgba(0, 0, 0, 0)");
  }
}

test(
  "File Manager find and replace controls follow light and dark appearance",
  {
    skip:
      process.platform === "linux" && !process.env.DISPLAY
        ? "Electron requires a display"
        : false,
  },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "pi-file-manager-theme-"));
    try {
      await writeFile(join(temp, "preload.cjs"), preloadFixture);
      await writeFile(join(temp, "main.cjs"), mainFixture);

      const env = { ...process.env, PI_FILE_MANAGER_VIEW: viewEntry };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(
        electronBinary,
        [join(temp, "main.cjs")],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      for (const stream of [child.stdout, child.stderr]) {
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          output += chunk;
        });
      }
      const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
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
        .find((item) => item.startsWith("FILE_MANAGER_THEME_PROBE "));
      assert.ok(line, output.slice(-6000));
      assert.equal(code, 0, output.slice(-6000));
      const report = JSON.parse(line.slice("FILE_MANAGER_THEME_PROBE ".length));
      assert.equal(report.ok, true, output.slice(-6000));
      assertTheme(report.result.dark, "dark");
      assertTheme(report.result.light, "light");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
