import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "pi-composer-suggestion-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const {
  PLUGIN_COMPOSER_SUGGESTION_MAX_CHARS,
  PLUGIN_COMPOSER_SUGGESTION_TTL_MS,
  PLUGIN_COMPOSER_SUGGESTION_TTL_MAX_MS,
} = await import("@pi-desktop/plugin-sdk");

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

function writePlugin({ id, permissions = [], main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-composer-suggestion-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, id, name: id, version: "0.0.1", main: "main.js", permissions }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

function makeRuntime(t, services = {}) {
  const audits = [];
  const toasts = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getLocale: () => "en",
    showToast: (message) => toasts.push(message),
    audit: (entry) => audits.push(entry),
    ...services,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits, toasts };
}

/** Wait for the plugin's own report, which arrives after its `onLoad`. */
async function lastToast(toasts, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (toasts.length > 0 && toasts.at(-1).startsWith(expected)) return toasts.at(-1);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no ${expected} toast; got ${JSON.stringify(toasts)}`);
}

test("a suggestion crosses from the plugin process with the text the shell draws", async (t) => {
  const offers = [];
  const { runtime, audits, toasts } = makeRuntime(t, {
    isPluginActiveInProject: () => true,
    suggestComposer: async (offer) => {
      offers.push(offer);
      return { shown: true };
    },
  });
  const dir = writePlugin({
    id: "demo.suggestion",
    permissions: ["composer.suggest"],
    main: `module.exports = {
      onLoad: async () => {
        const result = await pi.composer.suggest({
          sessionId: " session-1 ",
          turnId: "turn-1",
          text: "  Write\\nthe   failing test  ",
          ttlMs: 5000,
        });
        await pi.ui.showToast(JSON.stringify(result));
      },
    };`,
  });

  await runtime.loadFromPath(dir);
  assert.equal(await lastToast(toasts, "{"), '{"shown":true}');
  assert.deepEqual(offers, [
    {
      pluginId: "demo.suggestion",
      sessionId: "session-1",
      turnId: "turn-1",
      text: "Write the failing test",
      ttlMs: 5000,
    },
  ]);
  assert.equal(audits.some((entry) => entry.api === "composer.suggest" && entry.ok), true);
});

test("the host bounds the text and the lifetime instead of refusing them", async (t) => {
  const offers = [];
  const { runtime, toasts } = makeRuntime(t, {
    isPluginActiveInProject: () => true,
    suggestComposer: async (offer) => {
      offers.push(offer);
      return { shown: false, reason: "draft-not-empty" };
    },
  });
  const dir = writePlugin({
    id: "demo.suggestion.bounds",
    permissions: ["composer.suggest"],
    main: `module.exports = {
      onLoad: async () => {
        await pi.composer.suggest({ sessionId: "s", text: "x".repeat(500) });
        await pi.composer.suggest({ sessionId: "s", text: "y", ttlMs: 9_000_000 });
        await pi.ui.showToast(JSON.stringify(await pi.composer.suggest({ sessionId: "s", text: "z" })));
      },
    };`,
  });

  await runtime.loadFromPath(dir);
  assert.equal(await lastToast(toasts, "{"), '{"shown":false,"reason":"draft-not-empty"}');
  assert.equal(offers[0].text.length, PLUGIN_COMPOSER_SUGGESTION_MAX_CHARS);
  assert.equal(offers[1].ttlMs, PLUGIN_COMPOSER_SUGGESTION_TTL_MAX_MS);
  assert.equal(offers[2].ttlMs, PLUGIN_COMPOSER_SUGGESTION_TTL_MS);
});

test("a suggestion for a session the shell is not showing is a miss, not a throw", async (t) => {
  const { runtime, toasts } = makeRuntime(t, {
    // The plugin is scoped to another project, so this conversation is not its.
    isPluginActiveInProject: () => false,
    suggestComposer: async () => {
      throw new Error("the shell must not be asked");
    },
  });
  const dir = writePlugin({
    id: "demo.suggestion.scope",
    permissions: ["composer.suggest"],
    main: `module.exports = {
      onLoad: async () => {
        const result = await pi.composer.suggest({ sessionId: "session-1", text: "hi" });
        await pi.ui.showToast(JSON.stringify(result));
      },
    };`,
  });

  await runtime.loadFromPath(dir);
  assert.equal(await lastToast(toasts, "{"), '{"shown":false,"reason":"session-not-visible"}');
});

test("without the grant the call fails, and no suggestion is offered", async (t) => {
  const offers = [];
  const { runtime, toasts } = makeRuntime(t, {
    suggestComposer: async (offer) => {
      offers.push(offer);
      return { shown: true };
    },
  });
  const dir = writePlugin({
    id: "demo.suggestion.denied",
    permissions: ["composer.suggest"],
    main: `module.exports = {
      onLoad: async () => {
        try {
          await pi.composer.suggest({ sessionId: "session-1", text: "hi" });
          await pi.ui.showToast("NO_ERROR");
        } catch (error) {
          await pi.ui.showToast("ERR:" + (error && error.code ? error.code : String(error)));
        }
      },
    };`,
  });

  // Granted nothing: the manifest declares the permission, the user did not.
  await runtime.loadFromPath(dir, []);
  assert.equal(await lastToast(toasts, "ERR:"), "ERR:PERMISSION_DENIED");
  assert.deepEqual(offers, []);
});

test("a plugin's own clear reaches the shell, and a malformed call does not", async (t) => {
  const cleared = [];
  const { runtime, toasts } = makeRuntime(t, {
    suggestComposer: async () => ({ shown: true }),
    clearComposerSuggestion: (pluginId, sessionId) => cleared.push([pluginId, sessionId]),
  });
  const dir = writePlugin({
    id: "demo.suggestion.clear",
    permissions: ["composer.suggest"],
    main: `module.exports = {
      onLoad: async () => {
        await pi.composer.clearSuggestion({ sessionId: "session-1" });
        await pi.composer.clearSuggestion();
        try {
          await pi.composer.suggest({ sessionId: "  ", text: "hi" });
          await pi.ui.showToast("NO_ERROR");
        } catch (error) {
          await pi.ui.showToast("ERR:" + (error && error.code ? error.code : String(error)));
        }
      },
    };`,
  });

  await runtime.loadFromPath(dir);
  assert.equal(await lastToast(toasts, "ERR:"), "ERR:INVALID_PARAMS");
  assert.deepEqual(cleared, [
    ["demo.suggestion.clear", "session-1"],
    ["demo.suggestion.clear", undefined],
  ]);
});
