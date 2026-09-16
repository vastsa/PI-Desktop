/**
 * Plugin global shortcuts (permission `keyboard.globalShortcut`).
 *
 * First half: `PluginShortcutRegistry` driven by a fake platform, so ownership,
 * conflict, limit, and release rules are asserted without Electron.
 *
 * Second half: the real `PluginRuntime` with a forked host process and an
 * injected shortcut registry, so the declarative contribution, the permission
 * gate, the plugin-driven calls, and the release on unload are asserted through
 * the same seam the app wires to Electron's `globalShortcut`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

// Set before the runtime is imported so nothing a host call touches can land in
// the developer's real data directory.
const dataDir = mkdtempSync(join(tmpdir(), "pi-shortcut-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));


const PLUGIN_ID = "com.example.voice";
const VOICE_COMMAND = "voice.pushToTalk";
const VOICE_COMMANDS = [{ id: VOICE_COMMAND, title: "Push to talk" }];

// --- the registry on its own ------------------------------------------------
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  MAX_PLUGIN_GLOBAL_SHORTCUTS,
  PluginShortcutError,
  PluginShortcutRegistry,
} = await import("../electron/main/plugin-shortcut-registry.ts");
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
/**
 * The registry only ever sees this deps object: no Electron, no operating
 * system. `registerReturns` answers the platform calls in order, so a refusal
 * can be aimed at one registration.
 */
function fakePlatform({ platform = "linux", registerReturns = [], hostBindings } = {}) {
  const outcomes = [...registerReturns];
  const calls = { registered: [], unregistered: [], triggered: [], refused: [] };
  const handlers = new Map();
  /**
   * `hostBindings` is only attached when a test supplies it: omitting the dep
   * is what asks the registry for its shipped-default fallback.
   */
  const deps = {
    platform,
    register: (accelerator, handler) => {
      calls.registered.push(accelerator);
      if (!(outcomes.shift() ?? true)) return false;
      handlers.set(accelerator, handler);
      return true;
    },
    unregister: (accelerator) => {
      calls.unregistered.push(accelerator);
      handlers.delete(accelerator);
    },
    onTrigger: (entry) => {
      calls.triggered.push(entry);
    },
    onRefused: (info) => {
      calls.refused.push(info);
    },
  };
  if (hostBindings) deps.hostBindings = hostBindings;
  const registry = new PluginShortcutRegistry(deps);
  return { registry, calls, handlers };
}

/** Every refusal is a `PluginShortcutError`; `code` is what the plugin sees. */
function refusal(run, code) {
  assert.throws(run, (error) => {
    assert.ok(
      error instanceof PluginShortcutError,
      `expected PluginShortcutError, got ${error}`,
    );
    assert.equal(error.code, code);
    return true;
  });
}

test("a valid accelerator registers, lists, and fires its own handler", () => {
  const { registry, calls, handlers } = fakePlatform();

  const entry = registry.register({
    pluginId: PLUGIN_ID,
    id: VOICE_COMMAND,
    accelerator: "Alt+Shift+Space",
    command: VOICE_COMMAND,
  });

  assert.deepEqual(entry, {
    pluginId: PLUGIN_ID,
    id: VOICE_COMMAND,
    accelerator: "Alt+Shift+Space",
    electronAccelerator: "Alt+Shift+Space",
    command: VOICE_COMMAND,
  });
  assert.deepEqual(calls.registered, ["Alt+Shift+Space"]);
  assert.deepEqual(registry.list(PLUGIN_ID), [entry]);
  // A shortcut is per plugin: nobody else's list mentions it, and only the
  // stored entry (canonical accelerator) is handed back on a trigger.
  assert.deepEqual(registry.list("com.example.other"), []);
  handlers.get("Alt+Shift+Space")();
  assert.deepEqual(calls.triggered, [entry]);
  assert.deepEqual(calls.refused, []);
});

test("the canonical binding and the platform's accelerator spelling are kept apart", () => {
  for (const [platform, electron] of [
    ["win32", "Control+."],
    ["darwin", "Command+."],
  ]) {
    const { registry } = fakePlatform({ platform });
    const entry = registry.register({
      pluginId: PLUGIN_ID,
      id: "voice.talk",
      accelerator: "Mod+Period",
      command: VOICE_COMMAND,
    });
    assert.equal(entry.accelerator, "Mod+Period");
    assert.equal(entry.electronAccelerator, electron);
  }
});

test("re-registering an id moves it and frees the old accelerator", () => {
  const { registry, calls, handlers } = fakePlatform();

  registry.register({
    pluginId: PLUGIN_ID,
    id: VOICE_COMMAND,
    accelerator: "Alt+Shift+Space",
    command: VOICE_COMMAND,
  });
  const moved = registry.register({
    pluginId: PLUGIN_ID,
    id: VOICE_COMMAND,
    accelerator: "Alt+Shift+V",
    command: VOICE_COMMAND,
  });

  // The old binding was released with the accelerator Electron knew.
  assert.deepEqual(calls.unregistered, ["Alt+Shift+Space"]);
  assert.equal(handlers.has("Alt+Shift+Space"), false);
  assert.deepEqual(registry.list(PLUGIN_ID), [moved]);

  // And it is free again, for the same plugin or another one.
  const taken = registry.register({
    pluginId: "com.example.other",
    id: "voice.talk",
    accelerator: "Alt+Shift+Space",
    command: "voice.otherCommand",
  });
  assert.equal(taken.electronAccelerator, "Alt+Shift+Space");
});

test("an accelerator another plugin holds is refused, and the holder keeps working", () => {
  const { registry, calls, handlers } = fakePlatform();

  const incumbent = registry.register({
    pluginId: PLUGIN_ID,
    id: VOICE_COMMAND,
    accelerator: "Alt+Shift+Space",
    command: VOICE_COMMAND,
  });
  refusal(
    () =>
      registry.register({
        pluginId: "com.example.other",
        id: VOICE_COMMAND,
        accelerator: "Alt+Shift+Space",
        command: "voice.pushToTalk",
      }),
    "SHORTCUT_CONFLICT",
  );

  assert.deepEqual(registry.list("com.example.other"), []);
  // Refused before the platform was asked, so nothing was taken from anyone.
  assert.deepEqual(calls.registered, ["Alt+Shift+Space"]);
  assert.deepEqual(calls.refused, [
    {
      pluginId: "com.example.other",
      accelerator: "Alt+Shift+Space",
      code: "SHORTCUT_CONFLICT",
    },
  ]);
  handlers.get("Alt+Shift+Space")();
  assert.deepEqual(calls.triggered, [incumbent]);
});

test("a system-reserved binding is refused", () => {
  for (const [platform, accelerator] of [
    ["linux", "Mod+C"],
    ["darwin", "Mod+C"],
    // Only the key is case-folded; `Mod+c` still normalizes to the same binding.
    ["linux", "Mod+c"],
  ]) {
    const { registry, calls } = fakePlatform({ platform });
    refusal(
      () =>
        registry.register({
          pluginId: PLUGIN_ID,
          id: "voice.copy",
          accelerator,
          command: VOICE_COMMAND,
        }),
      "SHORTCUT_CONFLICT",
    );
    assert.deepEqual(registry.list(PLUGIN_ID), []);
    assert.deepEqual(calls.registered, []);
  }
});

test("without a live source the app's shipped defaults are refused", () => {
  for (const platform of ["linux", "darwin"]) {
    const { registry, calls } = fakePlatform({ platform });
    // D438/D439: the app spends `Alt+Shift+W` on the window toggle, and neither
    // retired chord (`Mod+W`, `Mod+Shift+W`) is held by anyone.
    for (const accelerator of ["Alt+Space", "Alt+Shift+W"]) {
      refusal(
        () =>
          registry.register({
            pluginId: PLUGIN_ID,
            id: "voice.launcher",
            accelerator,
            command: VOICE_COMMAND,
          }),
        "SHORTCUT_CONFLICT",
      );
    }
    assert.deepEqual(registry.list(PLUGIN_ID), []);
    assert.deepEqual(calls.registered, []);
  }
});

test("the macOS close-window chord is reserved, not merely unbound", () => {
  const { registry, calls } = fakePlatform({
    platform: "darwin",
    hostBindings: () => [],
  });
  // `Mod+W` is macOS's own close-window command. It is no longer the app's
  // default (D439), and it stays off-limits to plugins as well, so the platform
  // keeps the chord it owns.
  refusal(
    () =>
      registry.register({
        pluginId: PLUGIN_ID,
        id: "voice.close",
        accelerator: "Mod+W",
        command: VOICE_COMMAND,
      }),
    "SHORTCUT_CONFLICT",
  );
  assert.deepEqual(calls.registered, []);
});

test("the live host bindings decide, not the shipped defaults", () => {
  // The user rebound the window toggle, so `Alt+Shift+W` is free again while
  // whatever the app now holds is refused instead.
  const { registry, calls } = fakePlatform({ hostBindings: () => ["Mod+Shift+W"] });

  const freedDefault = registry.register({
    pluginId: PLUGIN_ID,
    id: "voice.pushToTalk",
    accelerator: "Alt+Shift+W",
    command: VOICE_COMMAND,
  });
  assert.equal(freedDefault.accelerator, "Alt+Shift+W");

  refusal(
    () =>
      registry.register({
        pluginId: PLUGIN_ID,
        id: "voice.toggle",
        accelerator: "Mod+Shift+W",
        command: VOICE_COMMAND,
      }),
    "SHORTCUT_CONFLICT",
  );
  // `register` receives Electron's platform spelling of the canonical binding.
  assert.deepEqual(calls.registered, ["Alt+Shift+W"]);
});

test("an empty live report still falls back to the shipped defaults", () => {
  const { registry, calls } = fakePlatform({ hostBindings: () => [] });

  refusal(
    () =>
      registry.register({
        pluginId: PLUGIN_ID,
        id: "voice.launcher",
        accelerator: "Alt+Space",
        command: VOICE_COMMAND,
      }),
    "SHORTCUT_CONFLICT",
  );
  assert.deepEqual(calls.registered, []);
});

test("a malformed accelerator is refused, with the raw spelling in the report", () => {
  const { registry, calls } = fakePlatform();

  for (const accelerator of ["NopeBig", "Ctrl+", "Alt+Ctrl", ""]) {
    refusal(
      () =>
        registry.register({
          pluginId: PLUGIN_ID,
          id: `voice.${accelerator}`,
          accelerator,
          command: VOICE_COMMAND,
        }),
      "INVALID_ACCELERATOR",
    );
  }

  assert.deepEqual(registry.list(PLUGIN_ID), []);
  assert.deepEqual(calls.registered, []);
  assert.deepEqual(calls.refused, [
    { pluginId: PLUGIN_ID, accelerator: "NopeBig", code: "INVALID_ACCELERATOR" },
    { pluginId: PLUGIN_ID, accelerator: "Ctrl+", code: "INVALID_ACCELERATOR" },
    { pluginId: PLUGIN_ID, accelerator: "Alt+Ctrl", code: "INVALID_ACCELERATOR" },
    { pluginId: PLUGIN_ID, accelerator: "", code: "INVALID_ACCELERATOR" },
  ]);
});

test("a platform refusal leaves nothing behind, not even the claim on the binding", () => {
  const { registry, calls } = fakePlatform({ registerReturns: [false] });

  refusal(
    () =>
      registry.register({
        pluginId: PLUGIN_ID,
        id: VOICE_COMMAND,
        accelerator: "Alt+Shift+X",
        command: VOICE_COMMAND,
      }),
    "SHORTCUT_UNAVAILABLE",
  );

  assert.deepEqual(registry.list(PLUGIN_ID), []);
  assert.deepEqual(registry.accelerators(), []);
  assert.deepEqual(calls.refused, [
    { pluginId: PLUGIN_ID, accelerator: "Alt+Shift+X", code: "SHORTCUT_UNAVAILABLE" },
  ]);

  // The failed attempt must not reserve the accelerator for anybody: the next
  // caller is served by the same platform call.
  const second = registry.register({
    pluginId: "com.example.other",
    id: VOICE_COMMAND,
    accelerator: "Alt+Shift+X",
    command: VOICE_COMMAND,
  });
  assert.equal(second.pluginId, "com.example.other");
  assert.equal(second.electronAccelerator, "Alt+Shift+X");
});

test("a plugin may hold at most eight accelerators", () => {
  const { registry, calls } = fakePlatform();
  assert.equal(MAX_PLUGIN_GLOBAL_SHORTCUTS, 8);

  for (let index = 1; index <= MAX_PLUGIN_GLOBAL_SHORTCUTS; index += 1) {
    registry.register({
      pluginId: PLUGIN_ID,
      id: `voice.shortcut${index}`,
      accelerator: `Alt+Shift+${index}`,
      command: VOICE_COMMAND,
    });
  }
  assert.equal(registry.list(PLUGIN_ID).length, MAX_PLUGIN_GLOBAL_SHORTCUTS);

  refusal(
    () =>
      registry.register({
        pluginId: PLUGIN_ID,
        id: "voice.shortcut9",
        accelerator: "Alt+Shift+9",
        command: VOICE_COMMAND,
      }),
    "LIMIT_EXCEEDED",
  );
  assert.deepEqual(calls.refused, [
    { pluginId: PLUGIN_ID, accelerator: "Alt+Shift+9", code: "LIMIT_EXCEEDED" },
  ]);

  // The ceiling is per plugin, and re-binding a held id is not a new entry.
  const foreign = registry.register({
    pluginId: "com.example.other",
    id: "voice.shortcut1",
    accelerator: "Alt+Shift+9",
    command: "voice.otherCommand",
  });
  assert.equal(foreign.pluginId, "com.example.other");
  const rebound = registry.register({
    pluginId: PLUGIN_ID,
    id: "voice.shortcut1",
    accelerator: "Ctrl+Alt+1",
    command: VOICE_COMMAND,
  });
  assert.equal(rebound.accelerator, "Ctrl+Alt+1");
  assert.equal(registry.list(PLUGIN_ID).length, MAX_PLUGIN_GLOBAL_SHORTCUTS);
});

test("releasePlugin drops one plugin's entries and unregisters each of them", () => {
  const { registry, calls } = fakePlatform();

  registry.register({
    pluginId: PLUGIN_ID,
    id: "voice.one",
    accelerator: "Alt+Shift+1",
    command: VOICE_COMMAND,
  });
  registry.register({
    pluginId: PLUGIN_ID,
    id: "voice.two",
    accelerator: "Alt+Shift+2",
    command: VOICE_COMMAND,
  });
  const survivor = registry.register({
    pluginId: "com.example.other",
    id: "voice.one",
    accelerator: "Alt+Shift+3",
    command: "voice.otherCommand",
  });

  registry.releasePlugin(PLUGIN_ID);

  assert.deepEqual(registry.list(PLUGIN_ID), []);
  assert.deepEqual(calls.unregistered, ["Alt+Shift+1", "Alt+Shift+2"]);
  assert.deepEqual(registry.list("com.example.other"), [survivor]);

  // A plugin that never held anything (or was already released) is a no-op.
  registry.releasePlugin(PLUGIN_ID);
  assert.deepEqual(calls.unregistered, ["Alt+Shift+1", "Alt+Shift+2"]);

  assert.equal(registry.unregister(PLUGIN_ID, "voice.one"), false);
  assert.equal(registry.unregister("com.example.other", "voice.one"), true);
  assert.deepEqual(registry.list("com.example.other"), []);
  assert.deepEqual(calls.unregistered, ["Alt+Shift+1", "Alt+Shift+2", "Alt+Shift+3"]);
});

test("the key is compared case-insensitively while modifier words are not", () => {
  const { registry } = fakePlatform();

  const functionKey = registry.register({
    pluginId: PLUGIN_ID,
    id: "voice.pushToTalk",
    accelerator: "f2",
    command: VOICE_COMMAND,
  });
  assert.equal(functionKey.accelerator, "F2");
  assert.equal(functionKey.electronAccelerator, "F2");
  // Same binding spelled differently: still one owner.
  refusal(
    () =>
      registry.register({
        pluginId: PLUGIN_ID,
        id: "voice.second",
        accelerator: "F2",
        command: VOICE_COMMAND,
      }),
    "SHORTCUT_CONFLICT",
  );

  // A lower-case modifier word is not a binding at all, so it never reaches the
  // host-owned comparison.
  refusal(
    () =>
      registry.register({
        pluginId: PLUGIN_ID,
        id: "voice.launcher",
        accelerator: "alt+space",
        command: VOICE_COMMAND,
      }),
    "INVALID_ACCELERATOR",
  );
});

// --- through the real runtime -----------------------------------------------

/** Real host process, forked instead of Electron's utilityProcess. */
function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

/**
 * A plugin that registers one command on load and exposes the three keyboard
 * host calls over its own panel channel, so refusals are asserted on the code
 * the plugin actually sees instead of on an unwrapped error.
 */
const PLUGIN_MAIN = `
  async function attempt(fn) {
    try {
      return { ok: true, value: (await fn()) ?? null };
    } catch (error) {
      return { ok: false, code: error?.code ?? "UNKNOWN", message: String(error?.message ?? "") };
    }
  }
  module.exports = {
    async onLoad() {
      await pi.commands.register({
        id: "voice.pushToTalk",
        title: "Push to talk",
        run: async () => { await pi.ui.showToast("push to talk"); },
      });
    },
    async onPanelInvoke(channel) {
      if (channel === "list") return pi.keyboard.listGlobalShortcuts();
      if (channel === "registerOwn") {
        return attempt(() => pi.keyboard.registerGlobalShortcut({
          id: "voice.panel",
          accelerator: "Alt+Shift+V",
          command: "voice.pushToTalk",
        }));
      }
      if (channel === "unregisterOwn") {
        return attempt(() => pi.keyboard.unregisterGlobalShortcut("voice.panel"));
      }
      if (channel === "registerForeign") {
        return attempt(() => pi.keyboard.registerGlobalShortcut({
          id: "voice.other",
          accelerator: "Alt+Shift+P",
          command: "voice.someoneElse",
        }));
      }
      throw new Error("unknown channel: " + channel);
    },
  };
`;

/** A voice plugin on disk; the temp directory dies with the test. */
function writePlugin(
  t,
  {
    id = PLUGIN_ID,
    permissions = ["keyboard.globalShortcut"],
    contributes = {
      commands: VOICE_COMMANDS,
      globalShortcuts: [
        { id: VOICE_COMMAND, command: VOICE_COMMAND, default: "Alt+Space" },
      ],
    },
    main = PLUGIN_MAIN,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "pi-shortcut-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: "Voice Plugin",
      version: "0.0.1",
      main: "main.js",
      permissions,
      contributes,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

function createRuntime(t, { pluginShortcuts } = {}) {
  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    audit: (entry) => audits.push(entry),
    ...(pluginShortcuts ? { pluginShortcuts } : {}),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits };
}

/**
 * A registry seam that answers exactly what the runtime asks of the real one.
 * `releasePlugin` runs through the same release path as `unregister`, which is
 * how the real registry turns a release into `unregister(electronAccelerator)`.
 */
function createRegistryStub() {
  const entries = new Map();
  const registered = [];
  const released = [];
  const keyOf = (pluginId, id) => `${pluginId}\u0000${id}`;
  const release = (entry) => {
    released.push({
      pluginId: entry.pluginId,
      id: entry.id,
      accelerator: entry.accelerator,
    });
    entries.delete(keyOf(entry.pluginId, entry.id));
  };
  return {
    registered,
    released,
    register(request) {
      registered.push({ ...request });
      entries.set(keyOf(request.pluginId, request.id), { ...request });
      return { ...request };
    },
    unregister(pluginId, id) {
      const entry = entries.get(keyOf(pluginId, id));
      if (!entry) return false;
      release(entry);
      return true;
    },
    releasePlugin(pluginId) {
      for (const entry of [...entries.values()]) {
        if (entry.pluginId === pluginId) release(entry);
      }
    },
    list(pluginId) {
      return [...entries.values()]
        .filter((entry) => entry.pluginId === pluginId)
        .map((entry) => ({ ...entry }));
    },
  };
}

/**
 * The production registry with its platform side stubbed: canonical bindings and
 * the Electron spelling come from the real mapping, only the OS is fake.
 */
function createRealPlatform({ platform = "linux", registerReturns = [], onTrigger } = {}) {
  const outcomes = [...registerReturns];
  const registered = [];
  const unregistered = [];
  const triggered = [];
  const handlers = new Map();
  const registry = new PluginShortcutRegistry({
    platform,
    register: (accelerator, handler) => {
      registered.push(accelerator);
      if (!(outcomes.shift() ?? true)) return false;
      handlers.set(accelerator, handler);
      return true;
    },
    unregister: (accelerator) => {
      unregistered.push(accelerator);
      handlers.delete(accelerator);
    },
    onTrigger: (entry) => {
      triggered.push(entry);
      onTrigger?.(entry);
    },
  });
  return { registry, registered, unregistered, triggered, handlers };
}

/** Polls instead of sleeping: a trigger hops through the plugin process. */
async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a declared global shortcut is registered for the plugin that owns the command", async (t) => {
  const stub = createRegistryStub();
  const { runtime, audits } = createRuntime(t, { pluginShortcuts: stub });
  const dir = writePlugin(t);

  await runtime.loadFromPath(dir);

  assert.deepEqual(stub.list(PLUGIN_ID), [
    {
      pluginId: PLUGIN_ID,
      id: VOICE_COMMAND,
      accelerator: "Alt+Space",
      command: VOICE_COMMAND,
    },
  ]);
  assert.deepEqual(
    audits
      .filter((entry) => entry.api === "keyboard.globalShortcut.register")
      .map((entry) => ({
        ok: entry.ok,
        accelerator: entry.accelerator,
        command: entry.command,
      })),
    [{ ok: true, accelerator: "Alt+Space", command: VOICE_COMMAND }],
  );

  // The plugin sees its own binding, once, through its own host call.
  assert.deepEqual(await runtime.invokePanelBridge(PLUGIN_ID, "list"), [
    {
      id: VOICE_COMMAND,
      accelerator: "Alt+Space",
      command: VOICE_COMMAND,
      registered: true,
    },
  ]);
});

test("a shortcut contribution is skipped when the permission was not granted", async (t) => {
  const stub = createRegistryStub();
  const { runtime, audits } = createRuntime(t, { pluginShortcuts: stub });
  const dir = writePlugin(t);

  // The manifest asks for the permission; the user granted nothing.
  await runtime.loadFromPath(dir, []);

  assert.deepEqual(stub.registered, []);
  assert.deepEqual(stub.list(PLUGIN_ID), []);
  const skipped = audits.filter(
    (entry) => entry.api === "keyboard.globalShortcut.register",
  );
  assert.deepEqual(
    skipped.map((entry) => ({ ok: entry.ok, errorCode: entry.errorCode })),
    [{ ok: false, errorCode: "PERMISSION_DENIED" }],
  );
  assert.ok(runtime.getLoaded(PLUGIN_ID), "a skipped shortcut must not fail the load");

  // The plugin's own call is shut for the same reason, and the registry is
  // never asked in either direction.
  const attempted = await runtime.invokePanelBridge(PLUGIN_ID, "registerOwn");
  assert.deepEqual(
    { ok: attempted.ok, code: attempted.code },
    { ok: false, code: "PERMISSION_DENIED" },
  );
  assert.deepEqual(stub.registered, []);
  assert.deepEqual(stub.list(PLUGIN_ID), []);
});

test("a manifest that declares a shortcut without the permission never loads", async (t) => {
  const stub = createRegistryStub();
  const { runtime } = createRuntime(t, { pluginShortcuts: stub });
  const dir = writePlugin(t, { permissions: [] });

  await assert.rejects(
    runtime.loadFromPath(dir),
    /contributes\.globalShortcuts requires the keyboard\.globalShortcut permission/,
  );

  assert.deepEqual(stub.registered, []);
  assert.deepEqual(runtime.listLoaded(), []);
});

test("the app's own launcher binding is refused to a plugin that declares it", async (t) => {
  const platform = createRealPlatform();
  const { runtime, audits } = createRuntime(t, { pluginShortcuts: platform.registry });
  const dir = writePlugin(t);

  await runtime.loadFromPath(dir);

  // `Alt+Space` is the plugin launcher's default, so the plugin keeps no
  // binding and the load still succeeds.
  const refusalEntry = audits.find(
    (entry) => entry.api === "keyboard.globalShortcut.register",
  );
  assert.deepEqual(
    { ok: refusalEntry.ok, errorCode: refusalEntry.errorCode },
    { ok: false, errorCode: "SHORTCUT_CONFLICT" },
  );
  assert.deepEqual(platform.registered, [], "the platform is never asked");
  assert.deepEqual(platform.registry.list(PLUGIN_ID), []);
  assert.ok(runtime.getLoaded(PLUGIN_ID));
});

test("a platform trigger runs the plugin's own command", async (t) => {
  let runtime;
  const platform = createRealPlatform({
    onTrigger: (entry) => {
      void runtime?.triggerPluginShortcut(entry);
    },
  });
  runtime = createRuntime(t, { pluginShortcuts: platform.registry }).runtime;
  const dir = writePlugin(t, {
    contributes: {
      commands: VOICE_COMMANDS,
      globalShortcuts: [
        { id: VOICE_COMMAND, command: VOICE_COMMAND, default: "Alt+Shift+Space" },
      ],
    },
  });

  await runtime.loadFromPath(dir);

  const [entry] = platform.registry.list(PLUGIN_ID);
  assert.deepEqual(
    {
      accelerator: entry.accelerator,
      electronAccelerator: entry.electronAccelerator,
      command: entry.command,
    },
    {
      accelerator: "Alt+Shift+Space",
      electronAccelerator: "Alt+Shift+Space",
      command: VOICE_COMMAND,
    },
  );
  assert.deepEqual(platform.registered, ["Alt+Shift+Space"]);

  platform.handlers.get("Alt+Shift+Space")();

  assert.deepEqual(platform.triggered, [entry]);
  const toasts = await waitFor(() => {
    const drained = runtime.drainToasts();
    return drained.length > 0 ? drained : null;
  });
  assert.deepEqual(toasts, ["push to talk"]);
});

test("a plugin registers and releases its own shortcut through the host API", async (t) => {
  const stub = createRegistryStub();
  const { runtime, audits } = createRuntime(t, { pluginShortcuts: stub });
  const dir = writePlugin(t, { contributes: { commands: VOICE_COMMANDS } });

  await runtime.loadFromPath(dir);
  assert.deepEqual(stub.list(PLUGIN_ID), []);

  assert.deepEqual(await runtime.invokePanelBridge(PLUGIN_ID, "registerOwn"), {
    ok: true,
    value: {
      id: "voice.panel",
      accelerator: "Alt+Shift+V",
      command: VOICE_COMMAND,
      registered: true,
    },
  });
  assert.deepEqual(stub.list(PLUGIN_ID), [
    {
      pluginId: PLUGIN_ID,
      id: "voice.panel",
      accelerator: "Alt+Shift+V",
      command: VOICE_COMMAND,
    },
  ]);

  assert.deepEqual(await runtime.invokePanelBridge(PLUGIN_ID, "unregisterOwn"), {
    ok: true,
    value: { ok: true },
  });
  assert.deepEqual(stub.list(PLUGIN_ID), []);
  assert.deepEqual(stub.released, [
    { pluginId: PLUGIN_ID, id: "voice.panel", accelerator: "Alt+Shift+V" },
  ]);
  assert.ok(
    audits.some(
      (entry) => entry.api === "keyboard.globalShortcut.unregister" && entry.ok === true,
    ),
  );
});

test("a shortcut for a command the plugin does not own is rejected", async (t) => {
  const stub = createRegistryStub();
  const { runtime } = createRuntime(t, { pluginShortcuts: stub });
  const dir = writePlugin(t, { contributes: { commands: VOICE_COMMANDS } });

  await runtime.loadFromPath(dir);

  const result = await runtime.invokePanelBridge(PLUGIN_ID, "registerForeign");

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_ARGUMENT");
  assert.match(result.message, /not registered by this plugin/);
  assert.deepEqual(stub.registered, []);
  assert.deepEqual(stub.list(PLUGIN_ID), []);
});

test("unloading a plugin releases the accelerators it holds", async (t) => {
  const stub = createRegistryStub();
  const { runtime } = createRuntime(t, { pluginShortcuts: stub });
  const dir = writePlugin(t);

  await runtime.loadFromPath(dir);
  assert.equal(stub.list(PLUGIN_ID).length, 1);

  await runtime.unload(PLUGIN_ID);

  assert.deepEqual(stub.list(PLUGIN_ID), []);
  assert.deepEqual(stub.released, [
    { pluginId: PLUGIN_ID, id: VOICE_COMMAND, accelerator: "Alt+Space" },
  ]);
});
