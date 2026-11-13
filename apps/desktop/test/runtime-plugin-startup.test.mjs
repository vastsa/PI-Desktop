import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register, registerHooks } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
// Native networking is a process boundary; these tests keep it disabled while
// exercising the real plugin restoration and sidecar-admission ordering.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "../network-proxy" && context.parentURL?.endsWith("/runtime/lifecycle.ts")) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(
      'export const currentNetworkDns = () => ({ mode: "system" }); export const currentSystemProxyRelayUrl = () => null;',
    )}` };
  }
  return next(specifier, context);
} });
const { createRuntimeLifecycle } = await import("../electron/main/runtime/lifecycle.ts");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, { load, listed, listError } = {}) {
  const dataDir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-plugin-startup-"));
  const runtimeState = { host: null, sidecar: null };
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const events = [];
  const failures = [];
  let quitting = false;
  const host = { async call(method) {
    if (method === "plugins.list") {
      if (listError) throw listError;
      return { plugins: listed ?? [{ id: "fixture", path: "fixture", enabled: true, source: "dev", permissions: ["ui.panel"] }] };
    }
    if (method === "workspace.get") return { workspace: { path: "workspace" } };
    if (method === "settings.get") return {};
  } };
  const lifecycle = createRuntimeLifecycle({
    dataDir,
    runtimeState,
    logger: { app(area, level, message) { if (level === "error") failures.push(message); } },
    sendToRenderer() {},
    async startHost() { events.push("host"); runtimeState.host = host; },
    async startSidecar() { events.push("sidecar"); },
    async drainApprovedPlanExecutions() { events.push("drain"); },
    async applyNetworkProxyFromAppSettings() { events.push("proxy"); },
    plugins: {
      setServices() { events.push("services"); },
      async loadFromPath(path, permissions, options) {
        events.push(`load:${path}`);
        await load?.(path, permissions, options);
        events.push(`ready:${path}`);
      },
      watchDevPlugin(id) { events.push(`watch:${id}`); },
    },
    setCurrentWorkspacePath() {},
    rememberPluginScopes() {},
    async refreshUserMcp() { events.push("mcp"); },
    isQuitting: () => quitting,
    getDisplayLocale: () => "en",
  });
  return { lifecycle, events, failures, quit() { quitting = true; } };
}

test("startup awaits enabled plugin initialization before spawning the agent sidecar", async (t) => {
  const entered = deferred();
  const ready = deferred();
  const f = await fixture(t, { async load(path, permissions, options) {
    assert.deepEqual(permissions, ["ui.panel"]);
    assert.deepEqual(options, { development: true });
    entered.resolve();
    await ready.promise;
  } });
  const boot = f.lifecycle.bootBackends();
  try {
    await entered.promise;
    assert.equal(f.events.includes("sidecar"), false, "Sidecar must not import model code before plugin initialization finishes");
  } finally {
    ready.resolve();
    await boot;
  }
  assert.deepEqual(f.events, ["host", "proxy", "services", "load:fixture", "ready:fixture", "watch:fixture", "sidecar", "mcp", "drain"]);
});

test("plugin failure is observable but does not block sidecar startup; disabled plugins stay unloaded", async (t) => {
  const f = await fixture(t, {
    listed: [
      { id: "disabled", path: "disabled", enabled: false },
      { id: "broken", path: "broken", enabled: true, permissions: [] },
      { id: "good", path: "good", enabled: true, permissions: [] },
    ],
    async load(path) { if (path === "broken") throw new Error("fixture initialization failed"); },
  });
  await f.lifecycle.bootBackends();
  assert.equal(f.events.includes("load:disabled"), false);
  assert.ok(f.events.indexOf("sidecar") > f.events.indexOf("ready:good"));
  assert.deepEqual(f.failures, ["plugin restore failed"]);
  assert.equal(f.events.at(-1), "drain");
});

test("an unavailable plugin registry does not prevent the normal agent startup", async (t) => {
  const f = await fixture(t, { listError: new Error("fixture registry unavailable") });
  await f.lifecycle.bootBackends();
  assert.deepEqual(f.failures, ["plugin list failed"]);
  assert.ok(f.events.includes("sidecar"));
});

test("quit during plugin initialization does not spawn a late sidecar or drain work", async (t) => {
  const f = await fixture(t, { async load() { f.quit(); } });
  await f.lifecycle.bootBackends();
  assert.equal(f.events.includes("sidecar"), false);
  assert.equal(f.events.includes("drain"), false);
});
