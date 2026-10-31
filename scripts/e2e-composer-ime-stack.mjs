#!/usr/bin/env node
/**
 * Real React/Chromium regressions: native composition must produce "/", not
 * "/、", and deleting text after a missing compositionend must reopen the menu.
 *
 * Mount production input, draft and completion wiring; drive native Chromium
 * composition through CDP as well as the lost-end event sequence from #929.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-ime-slash-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/composer-ime-stack.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      // The fixture lives outside the desktop package; use its React instance.
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
    plugins: [{
      name: "local-url-assets",
      setup(build) {
        build.onResolve({ filter: /\?url$/ }, ({ path, resolveDir }) => ({
          path: join(resolveDir, path.slice(0, -4)), namespace: "local-url-asset",
        }));
        build.onLoad({ filter: /.*/, namespace: "local-url-asset" }, async ({ path }) => ({
          contents: await readFile(path), loader: "file",
        }));
      },
    }],
  });
  const renderer = join(root, "apps/desktop/out/renderer");
  const appHtml = await readFile(join(renderer, "index.html"), "utf8");
  const css = [...appHtml.matchAll(/href="([^" ]+\.css)"/g)].map((match) => match[1]);
  assert(css.length, "Build the app with pnpm build:js before running this check");
  await cp(join(renderer, "assets"), join(temp, "assets"), { recursive: true });
  await writeFile(join(temp, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:;"><title>Composer IME slash menu</title>${css.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<body><script src="renderer.js"></script>`);
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const assert = require("node:assert/strict");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1040, height: 760, webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    const result = await window.webContents.executeJavaScript("globalThis.composerImeStackProbe()");
    assert.equal(result.ok, true, "existing IME recovery and completion paths must pass");
    window.webContents.debugger.attach("1.3");
    const js = expression => window.webContents.executeJavaScript(expression);
    const input = (method, params) => window.webContents.debugger.sendCommand("Input." + method, params);
    const state = () => js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(globalThis.composerImeState()))))");
    const reset = async (text = "") => {
      await js("globalThis.composerImeSetDraft(" + JSON.stringify(text) + ")");
      await state();
    };
    const expectText = (snapshot, expected, label) => {
      assert.equal(snapshot.dom, expected, label + " DOM: " + JSON.stringify(snapshot));
      assert.equal(snapshot.value, expected, label + " draft: " + JSON.stringify(snapshot));
    };
    const composed = async (prefix, candidate, committed, expected) => {
      await reset(prefix);
      await input("imeSetComposition", { text: candidate, selectionStart: candidate.length, selectionEnd: candidate.length });
      const pending = await state();
      expectText(pending, prefix + candidate, "pending composition must keep the native text");
      assert.equal(pending.composing, true);
      await input("insertText", { text: committed });
      const settled = await state();
      expectText(settled, expected, "committed composition");
      assert.equal(settled.caret, expected.length, "committed composition must retain the caret");
      assert.equal(settled.composing, false);
      return settled;
    };
    const slash = await composed("", "、", "、", "/");
    assert.equal(slash.open, true, "committed comma must open the slash menu");
    await composed("", "ni", "你", "你");
    await composed("你好", "、", "、", "你好、");
    await composed("、原文", "ni", "你", "、原文你");
    await reset();
    await input("imeSetComposition", { text: "、", selectionStart: 1, selectionEnd: 1 });
    await state();
    await input("imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    const cancelled = await state();
    assert.equal(cancelled.dom, "", "cancelled composition must leave no visible text");
    assert.equal(cancelled.value.trim(), "", "cancelled composition must leave a blank draft");
    assert.equal(cancelled.composing, false);
    for (const text of ["/", "、"]) {
      await reset();
      await input("insertText", { text });
      expectText(await state(), "/", "direct trigger " + text);
    }
    await reset();
    await input("imeSetComposition", { text: "n", selectionStart: 1, selectionEnd: 1 });
    await state();
    await reset("、保留");
    await input("insertText", { text: "你" });
    expectText(await state(), "、保留你", "a draft replacement must release the old composition origin");
    result.nativeComposition = true;
    console.log("COMPOSER_IME_STACK_PROBE " + JSON.stringify(result));
    app.exit(result && result.ok ? 0 : 1);
  } catch (error) {
    console.error("COMPOSER_IME_STACK_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
    app.exit(1);
  }
});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
    });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 60_000);
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
    .find((line) => line.startsWith("COMPOSER_IME_STACK_PROBE "));
  assert(
    line,
    `renderer returned no probe result (exit=${code}): ${output.slice(-2000)}`,
  );
  const result = JSON.parse(line.slice("COMPOSER_IME_STACK_PROBE ".length));
  for (const step of result.trace ?? []) {
    console.log(
      `  step ${String(step.label).padEnd(20)} draft=${JSON.stringify(step.draftValue)} composing=${step.composing} -> open=${step.open} hasItems=${step.hasItems} mode=${step.mode} query=${JSON.stringify(step.query)}`,
    );
  }
  console.log("COMPOSER_IME_STACK_PROBE " + JSON.stringify({ ok: result.ok, nativeComposition: result.nativeComposition }));
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(result.ok, true, "the slash menu did not reopen after the IME draft was cleared");
} finally {
  await rm(temp, { recursive: true, force: true });
}
