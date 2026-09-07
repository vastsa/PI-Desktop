/**
 * Plugin host process (ADR 0008).
 *
 * One instance runs exactly one plugin's main module, outside the Electron main
 * process. It owns no host capability: every `pi.*` call is proxied back to the
 * broker in `plugin-runtime.ts`, where the permission gateway and the host API
 * allowlist live. Plain ESM JS (not TS) so the same file can be forked directly
 * by tests and bundled to `out/main/plugin-host-process.js` for the app.
 *
 * Wire protocol (both directions, one JSON message per frame):
 *   parent -> child  { t: "init", id, pluginId, pluginPath, main, manifest }
 *   parent -> child  { t: "call", id, method, payload }   command.run | tool.execute |
 *                                                        service.start | service.stop |
 *                                                        lifecycle.unload
 *   child  -> parent { t: "call", id, api, args }         host API request
 *   *      -> *      { t: "res", id, ok, value } | { t: "res", id, ok: false, error: { code, message } }
 *   parent -> child  { t: "event", event, ... }           push, no reply (bus.message, host events)
 *   child  -> parent { t: "log", level, message }         diagnostics, fire and forget
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const parentPort = process.parentPort;

/** Electron utilityProcess and node:child_process disagree on the transport. */
function send(message) {
  if (parentPort) parentPort.postMessage(message);
  else process.send?.(message);
}

function onHostMessage(handler) {
  if (parentPort) parentPort.on("message", (event) => handler(event.data));
  else process.on("message", handler);
}

function log(level, message) {
  send({ t: "log", level, message: String(message) });
}

let pluginId = "";
let pluginPath = "";
let manifest = { id: "", name: "", version: "", main: "", schemaVersion: 1 };
let pluginModule = null;

const pending = new Map();
let nextCallId = 1;

/** Proxy a host API call to the broker and await its verdict. */
function call(api, args = []) {
  const id = `c${nextCallId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: "call", id, api, args });
  });
}

function settle(message) {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) {
    entry.resolve(message.value);
    return;
  }
  const error = new Error(message.error?.message || "plugin host call failed");
  error.code = message.error?.code || "UNKNOWN";
  entry.reject(error);
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (!value || typeof value !== "object") return new Uint8Array();
  const bytes = Object.entries(value)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, byte]) => Number(byte));
  return Uint8Array.from(bytes);
}

function normalizeClipboardHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    entry?.type === "image"
      ? { ...entry, data: asUint8Array(entry.data) }
      : entry,
  );
}

// Contribution points registered by this plugin. The callable half stays here;
// the broker only ever holds the descriptor plus a proxy back into this process.
const commands = new Map();
const tools = new Map();
// Resident services declared in the manifest. The broker decides when they run;
// this map only holds the callables and whether they are currently up.
const services = new Map();
// Bus subscriptions keyed by the id the broker handed out, plus the `pi.events`
// listeners. Both are driven by the parent's push frames.
const busHandlers = new Map();
const eventListeners = new Map();

function buildApi() {
  return {
    app: {
      getVersion: () => call("app.getVersion"),
      getLocale: () => call("app.getLocale"),
    },
    plugin: {
      getId: () => pluginId,
      getManifest: () => manifest,
      getSettings: () => call("plugin.getSettings"),
      setSettings: (partial) => call("plugin.setSettings", [partial]),
      getDataPath: () => call("plugin.getDataPath"),
    },
    commands: {
      register: async (command) => {
        if (!command || typeof command.id !== "string" || !command.id) {
          throw new Error("command.id is required");
        }
        if (typeof command.run !== "function") {
          throw new Error("command.run must be a function");
        }
        commands.set(command.id, command.run);
        try {
          await call("commands.register", [
            {
              id: command.id,
              title: command.title,
              keywords: command.keywords,
              category: command.category,
            },
          ]);
        } catch (error) {
          commands.delete(command.id);
          throw error;
        }
      },
      unregister: async (id) => {
        commands.delete(id);
        await call("commands.unregister", [id]);
      },
    },
    ui: {
      openPanel: (options) => call("ui.openPanel", [options]),
      closePanel: () => call("ui.closePanel"),
      showToast: (message, level) => call("ui.showToast", [message, level]),
      notify: (input) => call("ui.notify", [input]),
      getNotificationPermission: () => call("ui.getNotificationPermission"),
      requestNotificationPermission: () => call("ui.requestNotificationPermission"),
      showNativeNotification: (input) => call("ui.showNativeNotification", [input]),
    },
    workspace: {
      get: () => call("workspace.get"),
    },
    fs: {
      readText: (path) => call("fs.readText", [path]),
      readPreview: (path) => call("fs.readPreview", [path]),
      openDefault: (path) => call("fs.openDefault", [path]),
      reveal: (path) => call("fs.reveal", [path]),
      writeText: (path, content) => call("fs.writeText", [path, content]),
      glob: (pattern) => call("fs.glob", [pattern]),
      list: (path) => call("fs.list", [path]),
      remove: (path) => call("fs.remove", [path]),
      requestDirectory: () => call("fs.requestDirectory"),
    },
    agent: {
      registerTool: async (tool) => {
        if (!tool || typeof tool.name !== "string" || !tool.name) {
          throw new Error("tool.name is required");
        }
        if (typeof tool.execute !== "function") {
          throw new Error("tool.execute must be a function");
        }
        tools.set(tool.name, tool.execute);
        try {
          await call("agent.registerTool", [
            {
              name: tool.name,
              description: tool.description,
              risk: tool.risk,
              schema: tool.schema,
            },
          ]);
        } catch (error) {
          tools.delete(tool.name);
          throw error;
        }
      },
      unregisterTool: async (name) => {
        tools.delete(name);
        await call("agent.unregisterTool", [name]);
      },
    },
    /**
     * Resident background workers (spec 07 §3). Registration is local: the
     * manifest already declared the service, and the broker starts it only when
     * `background.service` was granted — so a plugin that registers without the
     * permission simply never runs.
     */
    services: {
      register: (service) => {
        if (!service || typeof service.id !== "string" || !service.id) {
          throw new Error("service.id is required");
        }
        if (typeof service.start !== "function") {
          throw new Error("service.start must be a function");
        }
        services.set(service.id, {
          start: service.start,
          stop: typeof service.stop === "function" ? service.stop : undefined,
          running: false,
        });
      },
      unregister: async (id) => {
        const entry = services.get(String(id ?? ""));
        services.delete(String(id ?? ""));
        if (entry?.running && entry.stop) await entry.stop();
      },
    },
    /**
     * Inter-plugin message bus (spec 07 §3). Topics must be declared in
     * `contributes.bus`; the broker owns the routing table, so this side only
     * keeps the handler for each subscription it was given.
     */
    bus: {
      publish: (topic, payload) => call("bus.publish", [topic, payload]),
      subscribe: async (topic, handler) => {
        if (typeof handler !== "function") {
          throw new Error("bus.subscribe handler must be a function");
        }
        const result = await call("bus.subscribe", [topic]);
        const id = String(result?.subscriptionId ?? "");
        busHandlers.set(id, handler);
        return async () => {
          busHandlers.delete(id);
          await call("bus.unsubscribe", [id]);
        };
      },
    },
    clipboard: {
      readText: () => call("clipboard.readText"),
      writeText: (text) => call("clipboard.writeText", [text]),
      getHistory: () => call("clipboard.getHistory").then(normalizeClipboardHistory),
    },
    shell: {
      openExternal: (url) => call("shell.openExternal", [url]),
    },
    browser: {
      navigate: (input) => call("browser.navigate", [input ?? {}]),
      action: (input) => call("browser.action", [input]),
      setBounds: (hole) => call("browser.setBounds", [hole]),
      setVisible: (visible) => call("browser.setVisible", [visible]),
      getState: () => call("browser.getState"),
      openExternal: () => call("browser.openExternal"),
      snapshot: () => call("browser.snapshot"),
      screenshot: (input) => call("browser.screenshot", [input ?? {}]),
      click: (input) => call("browser.click", [input]),
      fill: (input) => call("browser.fill", [input]),
      evaluate: (input) => call("browser.evaluate", [input]),
      console: (input) => call("browser.console", [input ?? {}]),
      cdp: (input) => call("browser.cdp", [input]),
    },
    net: {
      fetch: (input) => call("net.fetch", [input]),
    },
    // Fed by the parent's `event` frames; bus deliveries also arrive as
    // `bus.message` here, so a plugin can watch the raw stream if it wants to.
    events: {
      on: (event, handler) => {
        if (typeof handler !== "function") return;
        const listeners = eventListeners.get(event) ?? new Set();
        listeners.add(handler);
        eventListeners.set(event, listeners);
      },
      off: (event, handler) => {
        eventListeners.get(event)?.delete(handler);
      },
    },
  };
}

/** Dispatch one parent push frame; a throwing handler must not kill the plugin. */
function handleHostEvent(message) {
  const event = String(message.event ?? "");
  if (event === "bus.message") {
    const handler = busHandlers.get(String(message.subscriptionId ?? ""));
    if (handler) {
      try {
        handler(message.message);
      } catch (error) {
        log("warn", `bus handler failed for ${message.message?.topic}: ${error?.message ?? error}`);
      }
    }
  }
  const args = message.args ?? [message.message];
  for (const listener of [...(eventListeners.get(event) ?? [])]) {
    try {
      listener(...args);
    } catch (error) {
      log("warn", `event handler failed for ${event}: ${error?.message ?? error}`);
    }
  }
}

async function loadPluginModule(entry) {
  const require = createRequire(import.meta.url);
  try {
    delete require.cache[require.resolve(entry)];
    return require(entry);
  } catch (error) {
    if (error?.code === "ERR_REQUIRE_ESM" || error?.code === "ERR_REQUIRE_ASYNC_MODULE") {
      const mod = await import(pathToFileURL(entry).href);
      return mod?.default && typeof mod.default === "object" ? mod.default : mod;
    }
    throw error;
  }
}

async function handleInit(message) {
  pluginId = String(message.pluginId ?? "");
  pluginPath = String(message.pluginPath ?? "");
  manifest = message.manifest ?? manifest;
  const entry = join(pluginPath, String(message.main ?? manifest.main ?? ""));

  globalThis.pi = buildApi();
  pluginModule = await loadPluginModule(entry);
  if (pluginModule?.onLoad) await pluginModule.onLoad();
  return { pluginId };
}

async function handleParentCall(method, payload) {
  switch (method) {
    case "panel.invoke": {
      const invoke = pluginModule?.onPanelInvoke;
      if (typeof invoke !== "function") {
        const error = new Error("plugin does not expose panel operations");
        error.code = "UNSUPPORTED";
        throw error;
      }
      return invoke(String(payload?.channel ?? ""), payload?.payload ?? {});
    }
    case "command.run": {
      const run = commands.get(String(payload?.id ?? ""));
      if (!run) {
        const error = new Error(`command not registered: ${payload?.id}`);
        error.code = "NOT_FOUND";
        throw error;
      }
      await run();
      return { ok: true };
    }
    case "tool.execute": {
      const execute = tools.get(String(payload?.name ?? ""));
      if (!execute) {
        const error = new Error(`tool not registered: ${payload?.name}`);
        error.code = "TOOL_NOT_FOUND";
        throw error;
      }
      const result = await execute(payload?.args, {
        sessionId: payload?.sessionId,
        turnId: payload?.turnId,
        log: (msg) => log("info", msg),
      });
      return result ?? null;
    }
    case "service.start": {
      const id = String(payload?.id ?? "");
      const entry = services.get(id);
      if (!entry) {
        const error = new Error(`service not registered: ${id}`);
        error.code = "NOT_FOUND";
        throw error;
      }
      // Idempotent: a restart of the host process re-runs start, but a second
      // start inside one process must not spawn a duplicate worker.
      if (entry.running) return { ok: true, alreadyRunning: true };
      await entry.start({ log: (msg) => log("info", msg) });
      entry.running = true;
      return { ok: true };
    }
    case "service.stop": {
      const entry = services.get(String(payload?.id ?? ""));
      if (!entry?.running) return { ok: true };
      entry.running = false;
      if (entry.stop) await entry.stop();
      return { ok: true };
    }
    case "lifecycle.unload": {
      // Best effort: a throwing onUnload must not block teardown.
      try {
        if (pluginModule?.onUnload) await pluginModule.onUnload();
      } catch (error) {
        log("warn", `onUnload failed: ${error?.message ?? error}`);
      }
      commands.clear();
      tools.clear();
      services.clear();
      busHandlers.clear();
      eventListeners.clear();
      return { ok: true };
    }
    default: {
      const error = new Error(`unknown method: ${method}`);
      error.code = "UNSUPPORTED";
      throw error;
    }
  }
}

onHostMessage((message) => {
  if (!message || typeof message !== "object") return;
  if (message.t === "res") {
    settle(message);
    return;
  }
  if (message.t === "event") {
    handleHostEvent(message);
    return;
  }
  if (message.t === "init") {
    void handleInit(message)
      .then((value) => send({ t: "res", id: message.id, ok: true, value }))
      .catch((error) =>
        send({
          t: "res",
          id: message.id,
          ok: false,
          error: {
            code: error?.code || "PLUGIN_LOAD_FAILED",
            message: error?.message ? String(error.message) : String(error),
          },
        }),
      );
    return;
  }
  if (message.t === "call") {
    void handleParentCall(message.method, message.payload)
      .then((value) => send({ t: "res", id: message.id, ok: true, value: value ?? null }))
      .catch((error) =>
        send({
          t: "res",
          id: message.id,
          ok: false,
          error: {
            code: error?.code || "PLUGIN_CALL_FAILED",
            message: error?.message ? String(error.message) : String(error),
          },
        }),
      );
  }
});

// A misbehaving plugin must not take down its own host process silently, and it
// can never take down the app: the broker owns teardown decisions.
process.on("uncaughtException", (error) => {
  log("error", `uncaught exception: ${error?.stack || error}`);
});
process.on("unhandledRejection", (reason) => {
  log("error", `unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
