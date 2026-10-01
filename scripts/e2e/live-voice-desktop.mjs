import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveElectronBinary } from "./boot.mjs";
import { waitFor } from "./wait.mjs";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function launchLiveVoiceDesktop({ root, dataDir, profile, home, certificate, evidence, syntheticMicrophone = true }) {
  const { appDir, electronBinary } = resolveElectronBinary(root);
  const port = await availablePort();
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/TOKEN|API_KEY|SECRET|PASSWORD/.test(name) ||
      /^(?:NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|ELECTRON_RUN_AS_NODE|HTTPS?_PROXY|ALL_PROXY|PI_DESKTOP_PROXY_JSON|PI_DESKTOP_CAPTURE|DEBUG_HOST)$/i.test(name)) {
      delete env[name];
    }
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    PI_DESKTOP_DATA_DIR: dataDir,
    PI_DESKTOP_START_MAXIMIZED: "0",
    ELECTRON_RENDERER_URL: "",
    ...(certificate ? { NODE_EXTRA_CA_CERTS: certificate } : {}),
  });
  const child = spawn(electronBinary, [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    ...(syntheticMicrophone ? ["--use-fake-device-for-media-stream"] : []),
    ".",
  ], { cwd: appDir, env, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise((resolve) => child.once("exit", resolve));
  let launchError;
  child.once("error", (error) => { launchError = error; });
  child.stdout.resume();
  child.stderr.resume();
  // Each CDP target (the main window, the docked widget window) keeps its own
  // connection, so a step always acts on the surface it names.
  const connections = new Set();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const connection of connections) {
      for (const entry of connection.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Live Voice test browser closed"));
      }
      connection.pending.clear();
      connection.socket.close();
    }
    connections.clear();
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([exit, delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exit, delay(5_000)]);
      }
    }
    assert.ok(child.exitCode !== null || child.signalCode !== null, "isolated Electron exited");
  };
  try {
    // The main window and the docked widget window are separate CDP targets, and
    // The main window and the docked widget window are separate CDP targets, and
    // each gets its own connection, so a step always acts on the surface it
    // names: the composer, preparation menu and details in the main window, the
    // call bar in the widget.
    const attach = async (pick, label) => {
      let target;
      await waitFor(async () => {
        if (launchError) throw launchError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error("isolated Electron exited before its UI was ready");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/list`);
          target = (await response.json()).find((entry) => entry.type === "page" && pick(entry));
          return Boolean(target);
        } catch { return false; }
      }, 45_000, label);
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      const pending = new Map();
      let sequence = 0;
      const connection = { socket, pending };
      connections.add(connection);
      socket.addEventListener("close", () => connections.delete(connection));
      await once(socket, "open");
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`CDP request failed: ${message.error.code}`));
        else entry.resolve(message.result);
      };
      const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out`));
        }, 15_000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
      const evaluate = async (expression) => {
        const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (result.exceptionDetails) throw new Error("Live Voice browser assertion failed");
        return result.result.value;
      };
      const click = async (expression) => {
        let point;
        await waitFor(async () => {
          point = await evaluate(`(() => {
            const el = (${expression});
            if (!el || el.disabled) return null;
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + r.height / 2;
            return r.width && r.height && el.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
          })()`);
          return Boolean(point);
        }, 10_000, "clickable Live Voice control");
        for (const type of ["mousePressed", "mouseReleased"]) {
          await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
        }
      };
      const clickSelector = (selector) => click(`document.querySelector(${JSON.stringify(selector)})`);
      const clickText = (text, selector = "button") => click(
        `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim() === ${JSON.stringify(text)})?.closest('button')`,
      );
      const input = async (selector, value) => {
        await clickSelector(selector);
        await evaluate(`(() => document.querySelector(${JSON.stringify(selector)})?.select())()`);
        if (value) await send("Input.insertText", { text: value });
        else {
          for (const type of ["keyDown", "keyUp"]) {
            await send("Input.dispatchKeyEvent", { type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
          }
        }
      };
      const invoke = async (channel, ...args) => {
        const result = await evaluate(`window.piDesktop.invoke(window.piDesktop.channels.invoke[${JSON.stringify(channel)}], ...${JSON.stringify(args)})`);
        if (!result.ok) {
          const code = typeof result.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(result.error.code)
            ? result.error.code : "UNKNOWN";
          throw new Error(`Live Voice IPC ${channel} failed: ${code}`);
        }
        return result.data;
      };
      const screenshot = async (name) => {
        const result = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(join(evidence, name), Buffer.from(result.data, "base64"));
      };
      await send("Runtime.enable");
      await send("Page.enable");
      return { evaluate, click, clickSelector, clickText, input, invoke, screenshot };
    };
    const isMainWindow = (entry) => entry.url.includes("index.html") &&
      !entry.url.includes("plugin-launcher") && !entry.url.includes("live-voice-widget");
    const isWidgetWindow = (entry) => entry.url.includes("surface=live-voice-widget");
    const mainWindow = await attach(isMainWindow, "isolated Live Voice desktop CDP target");
    await waitFor(() => mainWindow.evaluate(`!!document.querySelector('[data-nav="settings"]') && !document.querySelector('.startup-splash')`),
      35_000, "Live Voice app navigation");
    let widgetWindow = null;
    return {
      close,
      ...mainWindow,
      /** The docked widget window: it appears when a call starts. */
      useWidget: async () => (widgetWindow ??= await attach(isWidgetWindow, "isolated Live Voice widget CDP target")),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
