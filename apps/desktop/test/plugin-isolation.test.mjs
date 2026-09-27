import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");
const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");
const viteConfigSrc = readFileSync(join(desktopRoot, "electron.vite.config.ts"), "utf8");

test("plugin runtime never loads plugin code inside the Electron main process", () => {
  assert.doesNotMatch(runtimeSrc, /createRequire/);
  assert.doesNotMatch(runtimeSrc, /globalThis as any\)\.pi/);
  assert.match(runtimeSrc, /utilityProcess\.fork/);
  assert.match(runtimeSrc, /plugin-host-process\.js/);
});

test("plugin host calls pass an allowlist and time out", () => {
  assert.match(runtimeSrc, /HOST_API_ALLOWLIST/);
  assert.match(runtimeSrc, /host api not available/);
  for (const token of [
    "PLUGIN_LOAD_TIMEOUT_MS",
    "PLUGIN_HOOK_TIMEOUT_MS",
    "PLUGIN_COMMAND_TIMEOUT_MS",
    "PLUGIN_TOOL_TIMEOUT_MS",
    "PLUGIN_PANEL_TIMEOUT_MS",
    "PLUGIN_COMPLETE_TIMEOUT_MS",
  ]) {
    assert.match(runtimeSrc, new RegExp(token));
  }
});

test("a dead plugin process is contained instead of fatal", () => {
  assert.match(runtimeSrc, /handleChildExit/);
  assert.match(runtimeSrc, /PLUGIN_CRASHED/);
  assert.match(runtimeSrc, /onPluginCrash/);
  // Crash cleanup must drop the plugin's contributions.
  assert.match(runtimeSrc, /clearContributions/);
});

test("plugin host process ships as its own bundled entry", () => {
  assert.match(viteConfigSrc, /plugin-host-process/);
});

/** Minimal broker stand-in: speaks the same protocol as PluginRuntime. */
function startHostProcess(pluginDir, manifest, hostApi) {
  const child = fork(hostProcessEntry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const pending = new Map();
  const received = [];
  let nextId = 1;
  const api = {
    "commands.register": () => ({ ok: true }),
    "commands.unregister": () => ({ ok: true }),
    "agent.registerTool": () => ({ ok: true }),
    "agent.unregisterTool": () => ({ ok: true }),
    ...hostApi,
  };

  child.on("message", (message) => {
    if (!message || typeof message !== "object") return;
    received.push(message);
    if (message.t === "res") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(Object.assign(new Error(message.error?.message), { code: message.error?.code }));
      return;
    }
    if (message.t === "call") {
      void Promise.resolve()
        .then(() => {
          const handler = api[message.api];
          if (!handler) throw Object.assign(new Error("not allowed"), { code: "UNSUPPORTED" });
          return handler(...(message.args ?? []));
        })
        .then((value) => child.send({ t: "res", id: message.id, ok: true, value: value ?? null }))
        .catch((error) =>
          child.send({
            t: "res",
            id: message.id,
            ok: false,
            error: { code: error.code ?? "FAILED", message: error.message },
          }),
        );
    }
  });

  const request = (message, timeoutMs = 5000) =>
    new Promise((resolvePromise, rejectPromise) => {
      const id = `h${nextId++}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`timeout waiting for ${message.t}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      child.send({ ...message, id });
    });

  return {
    child,
    received,
    logs: () => received.filter((m) => m.t === "log"),
    calls: () => received.filter((m) => m.t === "call"),
    init: () =>
      request({
        t: "init",
        pluginId: manifest.id,
        pluginPath: pluginDir,
        main: manifest.main,
        manifest,
      }),
    call: (method, payload, timeoutMs) => request({ t: "call", method, payload }, timeoutMs),
    stop: () => child.kill(),
  };
}

function writePlugin(main) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-"));
  mkdirSync(dir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id: "test.isolation",
    name: "Isolation Test",
    version: "0.0.1",
    main: "main.js",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return { dir, manifest };
}

test("plugin host process registers contributions and round-trips tool calls", async (t) => {
  const { dir, manifest } = writePlugin(`
    let unloaded = false;
    async function onLoad() {
      await pi.commands.register({
        id: "iso.open",
        title: "Isolation: Open",
        run: async () => {
          await pi.ui.showToast("ran");
        },
      });
      await pi.agent.registerTool({
        name: "echo",
        description: "echo",
        execute: async (args) => {
          const workspace = await pi.workspace.get();
          return { echo: args.text, workspace: workspace?.name, id: pi.plugin.getId() };
        },
      });
    }
    async function onUnload() {
      unloaded = true;
      await pi.ui.showToast("unloaded");
    }
    module.exports = { onLoad, onUnload };
  `);

  const toasts = [];
  const host = startHostProcess(dir, manifest, {
    "ui.showToast": (message) => {
      toasts.push(message);
      return { ok: true };
    },
    "workspace.get": () => ({ path: "/tmp/ws", name: "ws" }),
  });
  t.after(() => host.stop());

  await host.init();

  const registrations = host.calls().map((m) => m.api);
  assert.deepEqual(registrations, ["commands.register", "agent.registerTool"]);
  const commandDescriptor = host.calls()[0].args[0];
  assert.equal(commandDescriptor.id, "iso.open");
  assert.equal(commandDescriptor.title, "Isolation: Open");
  // The callable half must stay in the plugin process.
  assert.equal(commandDescriptor.run, undefined);
  assert.equal(host.calls()[1].args[0].execute, undefined);

  const result = await host.call("tool.execute", { name: "echo", args: { text: "hi" } });
  assert.deepEqual(result, { echo: "hi", workspace: "ws", id: "test.isolation" });

  await host.call("command.run", { id: "iso.open" });
  assert.deepEqual(toasts, ["ran"]);

  await host.call("lifecycle.unload", {});
  assert.deepEqual(toasts, ["ran", "unloaded"]);
});

test("plugin host process routes panel calls and workspace removal", async (t) => {
  const { dir, manifest } = writePlugin(`
    async function onPanelInvoke(channel, payload) {
      return { channel, removed: await pi.fs.remove(payload.path) };
    }
    module.exports = { onPanelInvoke };
  `);
  const removed = [];
  const host = startHostProcess(dir, manifest, {
    "fs.remove": (path) => {
      removed.push(path);
      return "removed";
    },
  });
  t.after(() => host.stop());

  await host.init();
  const result = await host.call("panel.invoke", {
    channel: "skill.remove",
    payload: { path: "skills/alpha/SKILL.md" },
  });
  assert.deepEqual(result, { channel: "skill.remove", removed: "removed" });
  assert.deepEqual(removed, ["skills/alpha/SKILL.md"]);
  assert.equal(host.calls().some((message) => message.api === "fs.remove"), true);
});

test("plugin host process round-trips native notification permission APIs", async (t) => {
  const { dir, manifest } = writePlugin(`
    async function onLoad() {
      await pi.commands.register({
        id: "iso.notify",
        title: "Isolation: Notify",
        run: async () => {
          await pi.ui.getNotificationPermission();
          await pi.ui.requestNotificationPermission();
          await pi.ui.showNativeNotification({ title: "Native", body: "Hello" });
        },
      });
    }
    module.exports = { onLoad };
  `);
  const calls = [];
  const host = startHostProcess(dir, manifest, {
    "ui.getNotificationPermission": () => {
      calls.push("get");
      return "unknown";
    },
    "ui.requestNotificationPermission": () => {
      calls.push("request");
      return "granted";
    },
    "ui.showNativeNotification": (input) => {
      calls.push({ type: "show", input });
      return { shown: true, permission: "granted" };
    },
  });
  t.after(() => host.stop());

  await host.init();
  await host.call("command.run", { id: "iso.notify" });
  assert.deepEqual(calls, [
    "get",
    "request",
    { type: "show", input: { title: "Native", body: "Hello" } },
  ]);
});

test("plugin host process reports denied host APIs and failing tools as errors", async (t) => {
  const { dir, manifest } = writePlugin(`
    async function onLoad() {
      await pi.agent.registerTool({
        name: "boom",
        description: "throws",
        execute: async () => {
          throw new Error("tool exploded");
        },
      });
      await pi.agent.registerTool({
        name: "denied",
        description: "calls a gated api",
        execute: async () => pi.fs.writeText("a.txt", "x"),
      });
    }
    module.exports = { onLoad };
  `);

  const host = startHostProcess(dir, manifest, {
    "fs.writeText": () => {
      throw Object.assign(new Error("missing permission: fs.write.workspace"), {
        code: "PERMISSION_DENIED",
      });
    },
  });
  t.after(() => host.stop());

  await host.init();

  await assert.rejects(() => host.call("tool.execute", { name: "boom", args: {} }), /tool exploded/);
  await assert.rejects(
    () => host.call("tool.execute", { name: "denied", args: {} }),
    (error) => error.code === "PERMISSION_DENIED",
  );
  await assert.rejects(
    () => host.call("tool.execute", { name: "missing", args: {} }),
    (error) => error.code === "TOOL_NOT_FOUND",
  );
});

test("a failing onLoad rejects the load instead of leaving a half-loaded plugin", async (t) => {
  const { dir, manifest } = writePlugin(`
    async function onLoad() {
      await pi.commands.register({ id: "half.loaded", title: "Half", run: async () => {} });
      throw new Error("onLoad failed");
    }
    module.exports = { onLoad };
  `);

  const host = startHostProcess(dir, manifest, { "ui.showToast": () => ({ ok: true }) });
  t.after(() => host.stop());

  await assert.rejects(() => host.init(), /onLoad failed/);
});

test("an uncaught plugin exception is logged without killing the host process", async (t) => {
  const { dir, manifest } = writePlugin(`
    async function onLoad() {
      await pi.agent.registerTool({
        name: "ping",
        description: "ping",
        execute: async () => "pong",
      });
      setTimeout(() => {
        throw new Error("late explosion");
      }, 10);
    }
    module.exports = { onLoad };
  `);

  const host = startHostProcess(dir, manifest, {});
  t.after(() => host.stop());

  await host.init();
  await new Promise((r) => setTimeout(r, 200));

  assert.ok(
    host.logs().some((m) => m.message.includes("late explosion")),
    "uncaught plugin errors must be reported to the broker",
  );
  assert.equal(await host.call("tool.execute", { name: "ping", args: {} }), "pong");
});
