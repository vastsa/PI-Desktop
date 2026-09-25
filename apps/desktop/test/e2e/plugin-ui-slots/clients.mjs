// Clients for the two surfaces the driver works through: the app's MCP
// control plane (sessions, prompts, turn status) and the real renderer over
// the Chrome DevTools Protocol (the DOM the slots draw into).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONTEXT_RESET = /Promise was collected|Execution context was destroyed|Cannot find context|Inspected target navigated/;

export async function connectControl(dataDir) {
  const info = JSON.parse(readFileSync(join(dataDir, "mcp-control.json"), "utf8"));
  let session;
  let sequence = 0;
  async function rpc(method, params) {
    const res = await fetch(info.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
    session = res.headers.get("mcp-session-id") ?? session;
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
  async function tool(name, args = {}) {
    const result = await rpc("tools/call", { name, arguments: args });
    const text = result?.content?.find((part) => part.type === "text")?.text;
    if (result?.isError) throw new Error(`${name}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  return {
    tool,
    async waitForTurn(sessionId, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const status = await tool("pi_agent_status", { sessionId });
        if (status?.status?.isRunning === false || status?.isRunning === false) return;
        await sleep(250);
      }
      throw new Error("turn did not finish");
    },
    async messages(sessionId) {
      const detail = await tool("pi_session_get", { id: sessionId, messageLimit: 200 });
      return detail?.session?.messages ?? [];
    },
  };
}

/**
 * The main window's page. `run(fn, arg)` evaluates `fn(arg)` in the page and
 * returns its (awaited, JSON) value; `until` polls `run` until it is truthy.
 */
export async function connectRenderer(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
  if (!target) throw new Error("Missing Electron renderer target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(String(data));
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    clearTimeout(waiter.timer);
    if (reply.error) waiter.reject(new Error(reply.error.message));
    else waiter.resolve(reply.result);
  });
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  async function run(fn, arg) {
    const reply = await call("Runtime.evaluate", {
      expression: `(${fn})(${JSON.stringify(arg ?? null)})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (reply.exceptionDetails) {
      throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    }
    return reply.result?.value;
  }
  // The window may sit behind other apps; without page focus Chromium ignores
  // element.focus(), and the focus-return checks would read the desktop's
  // window stacking instead of the app.
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await call("Page.enable", {});
  return {
    run,
    /** Runs `fn` now and in every later document of the window. */
    async install(fn) {
      await call("Page.addScriptToEvaluateOnNewDocument", { source: `(${fn})()` });
      // A navigation in flight runs the script on its new document instead.
      return run(fn).catch((error) => {
        if (!CONTEXT_RESET.test(error.message)) throw error;
      });
    },
    /** Reloads the window; `install`ed scripts run before its app code. */
    async reload() {
      await call("Page.reload", {});
    },
    // A poll that meets a navigating page (the evaluation is collected, or
    // its context is gone) reads as "not yet" and polls again.
    async until(fn, arg, label, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        try {
          last = await run(fn, arg);
        } catch (error) {
          if (!CONTEXT_RESET.test(error.message)) throw error;
          last = `(${error.message})`;
          await sleep(50);
          continue;
        }
        if (last) return last;
        await sleep(50);
      }
      throw new Error(`timed out waiting for ${label} (last ${JSON.stringify(last)})`);
    },
    async screenshot() {
      return (await call("Page.captureScreenshot", { format: "png" })).data;
    },
    close() {
      socket.close();
    },
  };
}
