#!/usr/bin/env node
/**
 * Real-Chromium regression for the composer's empty last line (#2433, #2555).
 *
 * Mounts the production `useComposerDraft` + `useComposerCompletions` +
 * `ComposerInput` wiring and drives it with CDP keyboard input, the way a user
 * types: three lines, a break inside line 1, then typing and deleting at the
 * draft end. Every step asserts the draft, the painted line count, the caret's
 * draft index and that the editable holds no invisible character.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const temp = await mkdtemp(join(tmpdir(), "pi-composer-tail-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/composer-tail-line.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".png": "dataurl" },
    define: {
      "import.meta.env.DEV": "false",
      "process.env.NODE_ENV": '"production"',
    },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await writeFile(
    join(temp, "tokens.css"),
    (await readFile(join(root, "apps/desktop/src/styles/tokens.css"), "utf8")).replace(
      /@theme(?: inline)?/g,
      ":root",
    ),
  );
  await writeFile(
    join(temp, "composer.css"),
    await readFile(join(root, "apps/desktop/src/styles/composer.css")),
  );
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="composer.css"><body style="margin:0;background:#111;color:#eee"><div id="root" style="width:640px"></div><script src="renderer.js"></script>`,
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
app.setPath("userData", path.join(__dirname, "profile"));
const SHIFT = 8;
const VK = { Enter: 13, Backspace: 8 };
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false, width: 760, height: 520,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.on("console-message", (event) => console.error("RENDERER " + event.message));
  try {
    await window.loadFile(path.join(__dirname, "index.html"));
    await window.webContents.debugger.attach("1.3");
    const js = (expression) => window.webContents.executeJavaScript(expression);
    const input = (method, params) => window.webContents.debugger.sendCommand("Input." + method, params);
    const frames = () => js("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const state = async () => {
      await frames();
      return js("globalThis.composerTailState()");
    };
    const failures = [];
    const expect = (condition, message, snapshot) => {
      if (condition) return;
      failures.push(message + " " + JSON.stringify(snapshot));
    };
    const press = async (key, modifiers = 0) => {
      const text = key === "Enter" ? "\\r" : undefined;
      await input("dispatchKeyEvent", {
        type: text ? "keyDown" : "rawKeyDown",
        key, code: key, modifiers,
        windowsVirtualKeyCode: VK[key] ?? 0,
        nativeVirtualKeyCode: VK[key] ?? 0,
        ...(text ? { text, unmodifiedText: text } : {}),
      });
      await input("dispatchKeyEvent", {
        type: "keyUp", key, code: key, modifiers,
        windowsVirtualKeyCode: VK[key] ?? 0,
        nativeVirtualKeyCode: VK[key] ?? 0,
      });
      await frames();
    };
    const type = async (text) => {
      await input("insertText", { text });
      await frames();
    };
    const clickLine = async (line) => js("globalThis.composerTailClickLine(" + line + ")");

    await js("globalThis.composerTailReset('')");
    await js("document.querySelector('.composer-input').focus()");
    await type("1test");
    await press("Enter", SHIFT);
    await type("2test");
    await press("Enter", SHIFT);
    await type("3test");
    const typed = await state();
    expect(typed.value === "1test\\n2test\\n3test", "one Enter must add exactly one line", typed);
    expect(typed.lineTops.length === 3, "three lines must paint three line boxes", typed);
    expect(typed.invisibleChars.length === 0, "the editable must hold no invisible character", typed);
    expect(typed.caret === typed.value.length, "the caret must stay at the draft end", typed);

    await js("globalThis.composerTailCaret(5)");
    await press("Enter", SHIFT);
    const brokenInLine1 = await state();
    expect(
      brokenInLine1.value === "1test\\n\\n2test\\n3test",
      "a break inside line 1 must add exactly one line",
      brokenInLine1,
    );
    expect(brokenInLine1.lineTops.length === 4, "four lines must paint four line boxes", brokenInLine1);
    expect(brokenInLine1.invisibleChars.length === 0, "a break must not leave a character behind", brokenInLine1);
    expect(brokenInLine1.caret === 6, "the caret must sit on the new empty line", brokenInLine1);

    const clicks = [];
    for (const line of [1, 2, 3, 4]) {
      const clicked = await clickLine(line);
      clicks.push(clicked.clickLine);
    }
    expect(
      JSON.stringify(clicks) === JSON.stringify([5, 6, 12, 18]),
      "each painted line must map to its own draft offset",
      { clicks },
    );
    const beyondLast = await clickLine(5);
    expect(beyondLast.clickLine !== null && beyondLast.clickLine === 18, "there is no line below the last one", beyondLast);

    await js("globalThis.composerTailCaret(" + JSON.stringify("1test\\n\\n2test\\n3test".length) + ")");
    await type("x");
    const typedAtEnd = await state();
    expect(typedAtEnd.value === "1test\\n\\n2test\\n3testx", "typing at the end must append there", typedAtEnd);
    expect(typedAtEnd.caret === typedAtEnd.value.length, "typing at the end must keep the caret at the end", typedAtEnd);

    await press("Backspace");
    const deletedAtEnd = await state();
    expect(deletedAtEnd.value === "1test\\n\\n2test\\n3test", "Backspace at the end must drop the last character", deletedAtEnd);
    expect(deletedAtEnd.caret === deletedAtEnd.value.length, "Backspace must keep the caret at the end", deletedAtEnd);

    await press("Enter", SHIFT);
    const tailBreak = await state();
    expect(tailBreak.value === "1test\\n\\n2test\\n3test\\n", "a trailing break must add one line", tailBreak);
    expect(tailBreak.invisibleChars.length === 0, "an empty last line must hold no character", tailBreak);
    await type("z");
    const typedOnEmptyLine = await state();
    expect(typedOnEmptyLine.value === "1test\\n\\n2test\\n3test\\nz", "the keystroke must land on the empty line", typedOnEmptyLine);
    expect(typedOnEmptyLine.lineTops.length === 5, "the empty last line must keep its box", typedOnEmptyLine);

    if (failures.length > 0) {
      console.error("COMPOSER_TAIL_LINE " + JSON.stringify({ ok: false, failures }));
      app.exit(1);
      return;
    }
    console.log("COMPOSER_TAIL_LINE " + JSON.stringify({ ok: true, clicks, last: typedOnEmptyLine }));
    app.exit(0);
  } catch (error) {
    console.error("COMPOSER_TAIL_LINE " + JSON.stringify({ ok: false, error: String(error), stack: error && error.stack }));
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
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => {
      output += data;
    });
  }
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
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
    .find((entry) => entry.startsWith("COMPOSER_TAIL_LINE "));
  if (!line) {
    console.error(output.slice(-6000));
    assert.fail(`renderer returned no tail-line result (exit=${code})`);
  }
  const result = JSON.parse(line.slice("COMPOSER_TAIL_LINE ".length));
  if (!result.ok) {
    console.error("COMPOSER_TAIL_LINE " + JSON.stringify(result, null, 2));
    assert.fail(`composer tail-line regression: ${result.failures?.join(" | ") ?? result.error}`);
  }
  console.log("COMPOSER_TAIL_LINE " + JSON.stringify(result));
  assert.equal(code, 0, output.slice(-4000));
} finally {
  await rm(temp, { recursive: true, force: true });
}
