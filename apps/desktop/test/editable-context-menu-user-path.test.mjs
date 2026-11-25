import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot, resolveElectronBinary } from "../../../scripts/e2e/boot.mjs";

const root = repositoryRoot();
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const aliases = {
  "@pi-desktop/shared": join(root, "packages/shared/src"),
  "@pi-desktop/i18n": join(root, "packages/i18n/src"),
};

const renderer = `
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useRef, useState } from "react";
import { ComposerInput } from "../../apps/desktop/src/features/chat/composer/ComposerInput";
window.probe = { value: "" };
const noop = () => {};
function Fixture() {
  const ref = useRef(null);
  const [value, setValue] = useState("");
  window.probe.value = value;
  return <ComposerInput inputRef={ref} value={value} placeholderText="" placeholderKey="fixture"
    inputBlocked={false} pasting={false} enterToSend={false} runActive={false}
    composerAc={{ open: false, hasItems: false, close: noop }}
    onPaste={noop}
    onInput={(text) => setValue(text)} onAcceptCompletion={noop} onSubmit={noop}
    onInsertNewline={noop} onHistoryNavigate={() => false} onCompositionStart={noop}
    onCompositionEnd={noop} onSettledInput={noop} onFocus={noop} onBlur={noop} />;
}
flushSync(() => createRoot(document.getElementById("root")).render(<Fixture />));
`;

const main = `
import assert from "node:assert/strict";
import { app, BrowserWindow, Menu } from "electron";
import { installEditableContextMenu } from "../../apps/desktop/electron/main/application-menu";
import { waitFor } from "./wait.mjs";
app.setPath("userData", process.argv[2]);
app.whenReady().then(async () => {
const win = new BrowserWindow({ show: true, width: 800, height: 600,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
const wc = win.webContents;
let opened;
// Keep native editing roles while replacing the OS popup boundary.
Menu.prototype.popup = function (options) { opened = { menu: this, options }; };
installEditableContextMenu(win);
const read = (expression) => wc.executeJavaScript(expression);
async function openMenu() {
  opened = undefined;
  const point = await read('(() => { const r = document.querySelector(".composer-input").getBoundingClientRect(); return {x: Math.round(r.x + 5), y: Math.round(r.y + 5)}; })()');
  const event = new Promise((resolve) => wc.once("context-menu", (_event, params) => resolve(params)));
  wc.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...point });
  wc.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...point });
  return event;
}
async function command(role, expression, expected) {
  const item = opened.menu.items.find((candidate) => candidate.role === role);
  assert.equal(item?.enabled, true, role + " must be enabled");
  if (process.platform === "darwin") Menu.sendActionToFirstResponder(role === "selectall" ? "selectAll:" : role + ":");
  else item.click({}, win, wc);
  await waitFor(async () => (await read(expression)) === expected, 5_000, role + " to update the editor");
}
try {
  Menu.setApplicationMenu(null);
  await win.loadFile(process.argv[3]);
  win.focus();
  await waitFor(() => win.isFocused(), 5_000, "fixture window focus");
  await read('document.querySelector(".composer-input").focus()');
  await wc.insertText("alpha beta");
  await read('const range = document.createRange(); const node = document.querySelector(".composer-input").firstChild; range.setStart(node, 0); range.setEnd(node, 5); window.getSelection().removeAllRanges(); window.getSelection().addRange(range)');
  const params = await openMenu();
  assert.ok(opened, "Right-clicking the composer must open an editing menu");
  const roles = opened.menu.items.filter((item) => item.type !== "separator");
  assert.deepEqual(roles.map((item) => item.role), ["undo", "redo", "cut", "copy", "paste", "selectall"]);
  assert.deepEqual(roles.map((item) => item.enabled), [params.editFlags.canUndo, params.editFlags.canRedo,
    params.editFlags.canCut, params.editFlags.canCopy, params.editFlags.canPaste, params.editFlags.canSelectAll]);
  assert.equal(opened.options.window, win);
  assert.equal(opened.options.frame, params.frame);
  assert.equal(await read('window.getSelection().toString()'), "alpha");
  await wc.insertText("gamma");
  assert.equal(await read("window.probe.value"), "gamma beta");
  await openMenu(); await command("undo", "window.probe.value", "alpha beta");
  await openMenu(); await command("redo", "window.probe.value", "gamma beta");
  await openMenu(); await command("selectall", "window.getSelection().toString()", "gamma beta");
  await read('document.querySelector(".composer-input").contentEditable = "false"');
  await openMenu();
  assert.equal(opened, undefined, "read-only controls do not open the editing menu");
  console.log("EDITABLE_MENU_PROBE passed");
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  win.destroy();
}
app.exit(process.exitCode || 0);
});
`;

test("composer right-click preserves selection and native editing history", {
  skip: process.platform === "linux" && !process.env.DISPLAY ? "Electron requires a display" : false,
  timeout: 30_000,
}, async () => {
  const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-editable-menu-"));
  try {
    await build({ stdin: { contents: renderer, resolveDir: join(root, "scripts/e2e"), loader: "tsx" },
      outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { ...aliases, ...Object.fromEntries(["react", "react-dom", "i18next", "react-i18next"].map((name) => [name, join(root, "apps/desktop/node_modules", name)])) },
      nodePaths: [join(root, "apps/desktop/node_modules")],
    });
    await build({ stdin: { contents: main, resolveDir: join(root, "scripts/e2e") },
      outfile: join(temp, "main.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"], alias: aliases });
    await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><style>.composer-input{min-height:100px;white-space:pre-wrap}</style><div id="root"></div><script type="module" src="renderer.js"></script>');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(resolveElectronBinary(root).electronBinary,
      [join(temp, "main.cjs"), join(temp, "profile"), join(temp, "index.html")],
      { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, 0, output);
      assert.match(output, /EDITABLE_MENU_PROBE passed/);
    } finally { clearTimeout(timer); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
