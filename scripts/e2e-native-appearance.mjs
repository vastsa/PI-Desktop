#!/usr/bin/env node
/**
 * Native OS appearance-transition E2E (#2228 / #2215).
 *
 * Flips the real Windows app theme (registry + WM_SETTINGCHANGE broadcast),
 * drives the shipped app through the production path — Electron
 * `nativeTheme.updated` → app-lifecycle re-resolve → `appearance:changed`
 * broadcast → shipped pi.browser panel `setBaseTheme` — and asserts the
 * plugin panel palette flips both ways and back. Restores the original OS
 * setting even on failure.
 *
 * Windows only: the OS flip is registry-based. Other platforms skip cleanly.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { waitFor } from "./e2e/wait.mjs";

if (process.platform !== "win32") {
  console.log("e2e-native-appearance: skip (windows-only scenario)");
  process.exit(0);
}

const personalizationKey = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";

function powershellJson(script) {
  const stdout = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-Command", `& { ${script} } | ConvertTo-Json -Compress`],
    { encoding: "utf8", timeout: 20_000 },
  );
  return JSON.parse(stdout.trim() || "null");
}

function readAppsUseLightTheme() {
  const value = powershellJson(
    `(Get-ItemProperty -Path '${personalizationKey}' -Name AppsUseLightTheme).AppsUseLightTheme`,
  );
  assert.ok(value === 0 || value === 1, `unexpected AppsUseLightTheme value: ${value}`);
  return value;
}

/** Flip the real OS app theme and broadcast the change like Windows Settings does. */
function writeAppsUseLightTheme(value) {
  assert.ok(value === 0 || value === 1, `unexpected AppsUseLightTheme value: ${value}`);
  powershellJson(`
$value = ${value}
Set-ItemProperty -Path '${personalizationKey}' -Name AppsUseLightTheme -Value $value
Add-Type -Namespace PiE2E -Name Native -MemberDefinition '[DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);'
$result = [IntPtr]::Zero
[PiE2E.Native]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [IntPtr]::Zero, 'ImmersiveColorSet', 2, 2000, [ref]$result) | Out-Null
'sent'
`);
}

const evidence = process.env.PI_NATIVE_APPEARANCE_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });

const temp = mkdtempSync(join(tmpdir(), "pi-native-appearance-e2e-"));
const dataDir = join(temp, "data");
const project = join(temp, "project");
mkdirSync(project);

const originalLight = readAppsUseLightTheme();
console.log("OS AppsUseLightTheme at start:", originalLight);

const host = new Host(resolveHostBinary(), dataDir, {
  env: {
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GOOGLE_API_KEY: "",
    OPENROUTER_API_KEY: "",
    PI_DESKTOP_TEST_API_KEY: "",
    PI_DESKTOP_TEST_BASE_URL: "",
    PI_DESKTOP_TEST_MODEL: "",
  },
});
await host.start();
await host.call("workspace.set", { path: project });
await host.call("settings.set", { language: "zh-CN", theme: "system" });
await host.stop();

const { appDir, electronBinary } = resolveElectronBinary();
const port = Number(process.env.PI_NATIVE_APPEARANCE_CDP_PORT || 9392);
const env = {
  ...process.env,
  PI_DESKTOP_DATA_DIR: dataDir,
  PI_DESKTOP_START_MAXIMIZED: "0",
  ELECTRON_RENDERER_URL: "",
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  electronBinary,
  [`--remote-debugging-port=${port}`, `--user-data-dir=${join(temp, "profile")}`, "."],
  { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
);
const childClose = new Promise((resolve) => child.once("close", resolve));
const waitForChildExit = async (timeoutMs) => {
  let timer;
  const exited = await Promise.race([
    childClose.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return exited;
};
let output = "";
child.stdout.on("data", (data) => {
  output += data;
});
child.stderr.on("data", (data) => {
  output += data;
});

/** Minimal CDP client over one page target. */
function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  return (async () => {
    await once(ws, "open");
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    };
    const send = (method, params = {}) =>
      new Promise((resolveCall, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve: resolveCall, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails),
        );
      return result.result.value;
    };
    return { send, evaluate, close: () => ws.close() };
  })();
}

const listTargets = async () =>
  (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(
    (entry) => entry.type === "page",
  );

let desktop;
try {
  let mainTarget;
  await waitFor(
    async () => {
      try {
        mainTarget = listTargets().then((entries) =>
          entries.find(
            (entry) =>
              entry.url.includes("index.html") && !entry.url.includes("plugin-launcher"),
          ),
        );
        return !!(await mainTarget);
      } catch {
        return false;
      }
    },
    30_000,
    "desktop CDP target",
  );
  desktop = await connect(await mainTarget);
  console.log("Desktop target", (await mainTarget).url);
  await desktop.send("Page.enable");

  await waitFor(
    () =>
      desktop.evaluate(
        `!!document.querySelector('[data-nav="settings"]') && !document.querySelector('.startup-splash')`,
      ),
    30_000,
    "desktop ready",
  );

  // Open the Browser the way the app does: the work-panel new-tab launcher
  // entry contributed by pi.browser. The launcher carries a stable
  // `data-work-panel-launcher-item` hook, so the click does not depend on
  // localized labels. The side panel itself may start collapsed on the home
  // screen, so toggle it with its Ctrl+J button first when needed.
  const clickPoint = async (selector) => {
    const hit = await desktop.evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)});
      if (!button || button.disabled) return null;
      button.scrollIntoView({ block: 'nearest' });
      const r = button.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (button.contains(document.elementFromPoint(x, y))) return { x, y, direct: false };
      // Covered by an overlay surface: fall back to the DOM activation path,
      // which still runs the production onClick wiring.
      button.click();
      return { direct: true };
    })()`);
    if (!hit) return false;
    if (hit.direct) return true;
    await desktop.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...hit,
      button: "left",
      clickCount: 1,
    });
    await desktop.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...hit,
      button: "left",
      clickCount: 1,
    });
    return true;
  };
  const clickByText = async (pattern) => {
    const hit = await desktop.evaluate(`(() => {
      const pattern = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
      const matches = (e) => {
        const label = [e.textContent, e.getAttribute('aria-label'), e.getAttribute('title')]
          .filter(Boolean).join(' ');
        return pattern.test(label);
      };
      const button = [...document.querySelectorAll('button')]
        .find((e) => matches(e) && !e.disabled && !e.closest('[aria-hidden="true"]'));
      if (!button) return null;
      button.scrollIntoView({ block: 'nearest' });
      const r = button.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return button.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    })()`);
    if (!hit) return false;
    await desktop.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...hit,
      button: "left",
      clickCount: 1,
    });
    await desktop.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...hit,
      button: "left",
      clickCount: 1,
    });
    return true;
  };
  const launcherSelector = '[data-work-panel-launcher-item="pi.browser/browser"]';
  // The work panel (and its toggle) only enable with an active session, so
  // start a temp conversation the way a first-run user would.
  const startedSession = await clickByText(/新建临时对话|新任务|new (task|chat)/i);
  if (!startedSession) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(
      await desktop.evaluate(`!!document.querySelector(${JSON.stringify(launcherSelector)})`),
      "could not start a session or find the work-panel launcher",
    );
  }
  let launcherVisible = await desktop.evaluate(`!!document.querySelector(${JSON.stringify(launcherSelector)})`);
  for (let attempt = 0; attempt < 3 && !launcherVisible; attempt += 1) {
    if (attempt === 0) {
      // The work-panel toggle advertises Ctrl+J; drive the real shortcut.
      for (const type of ["keyDown", "keyUp"]) {
        await desktop.send("Input.dispatchKeyEvent", {
          type,
          modifiers: 2,
          windowsVirtualKeyCode: 74,
          code: "KeyJ",
          key: "j",
        });
      }
    } else {
      const toggled = await clickByText(/切换侧边面板|侧边面板|side panel/i);
      if (!toggled) {
        const buttons = await desktop.evaluate(
          `[...document.querySelectorAll('button')].map((e) => ({
            label: (e.textContent || e.title || e.getAttribute('aria-label') || '').trim(),
            disabled: e.disabled,
            hidden: !!e.closest('[aria-hidden="true"]'),
            rect: (() => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })(),
          })).filter((e) => e.label).slice(0, 60)`,
        );
        console.log("Visible buttons for diagnosis:", JSON.stringify(buttons));
        throw new Error("work panel toggle button not found");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    launcherVisible = await desktop.evaluate(`!!document.querySelector(${JSON.stringify(launcherSelector)})`);
  }
  assert.ok(launcherVisible, "work-panel launcher never appeared");
  // Activate the launcher entry until the pi.browser panel view actually
  // exists — a successful click removes the launcher pane, so the CDP target
  // is the real success signal, not the click's return value.
  let browserTarget = null;
  await waitFor(
    async () => {
      try {
        browserTarget = (await listTargets()).find((entry) =>
          entry.url.includes("browser.html"),
        );
        if (browserTarget) return true;
      } catch {}
      await clickPoint(launcherSelector);
      return false;
    },
    20_000,
    "pi.browser panel view after launcher click",
  );

  let browserClient;
  await waitFor(
    async () => {
      if (browserClient) return true;
      try {
        const target = browserTarget ?? (await listTargets()).find((entry) =>
          entry.url.includes("browser.html"),
        );
        if (!target) return false;
        browserClient = await connect(target);
        return true;
      } catch {
        return false;
      }
    },
    20_000,
    "pi.browser panel CDP connection",
  );
  console.log("Browser panel target connected");

  const readBase = () =>
    browserClient.evaluate(`document.documentElement?.dataset?.base || null`);
  const readLang = () =>
    browserClient.evaluate(`document.documentElement?.lang || null`);

  // The repo waitFor gates pass/timeout without returning the polled value,
  // so read the attribute again once the gate passes.
  await waitFor(
    async () => {
      const base = await readBase();
      return base === "light" || base === "dark";
    },
    15_000,
    "initial plugin panel base",
  );
  const initialBase = await readBase();
  console.log("Panel base at start:", initialBase, "lang:", await readLang());
  if (evidence) {
    const shot = await desktop.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(evidence, "appearance-before.png"), Buffer.from(shot.data, "base64"));
  }

  // Real OS flip #1: light ↔ dark, whichever direction moves away from the
  // current base. Electron's nativeTheme fires `updated`, the lifecycle
  // re-resolves the palette and broadcasts, the shipped panel repaints.
  const flipOne = initialBase === "light" ? 0 : 1;
  writeAppsUseLightTheme(flipOne);
  await waitFor(
    async () => {
      const base = await readBase();
      return base !== initialBase && (base === "light" || base === "dark");
    },
    20_000,
    `panel base flip to ${flipOne === 0 ? "dark" : "light"}`,
  );
  const flippedBase = await readBase();
  console.log("Panel base after OS flip:", flippedBase);
  assert.equal(flippedBase, flipOne === 0 ? "dark" : "light");

  if (evidence) {
    const shot = await desktop.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(evidence, "appearance-after-flip.png"), Buffer.from(shot.data, "base64"));
  }

  // Real OS flip #2: back to the original appearance, proving the palette
  // follows the OS in both directions rather than latching.
  writeAppsUseLightTheme(originalLight);
  await waitFor(
    async () => (await readBase()) === initialBase,
    20_000,
    `panel base restore to ${initialBase}`,
  );
  const restoredBase = await readBase();
  console.log("Panel base after OS restore:", restoredBase);
  assert.equal(restoredBase, initialBase);
  console.log("E2E native appearance: PASS");
} finally {
  // Restore the user's OS appearance even when assertions failed midway.
  try {
    writeAppsUseLightTheme(originalLight);
  } catch (restoreError) {
    console.error("Failed to restore OS appearance:", restoreError);
  }
  try {
    if (desktop) await desktop.close();
  } catch {}
  if (process.platform === "win32") child.kill("SIGTERM");
  else child.kill("SIGINT");
  if (!(await waitForChildExit(3000))) {
    child.kill("SIGKILL");
    if (!(await waitForChildExit(3000))) {
      if (process.platform === "win32") child.kill("SIGKILL");
    }
  }
  if (process.exitCode === undefined || process.exitCode === 0) {
    if (output.includes("Uncaught Exception") || output.includes("FATAL")) {
      console.error("App reported a fatal error during the run:");
      console.error(output.slice(-2000));
      process.exitCode = 1;
    }
  }
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
