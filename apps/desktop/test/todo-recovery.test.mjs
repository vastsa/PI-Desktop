import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { IPC } from "@pi-desktop/shared";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

// Run the production component's effects explicitly. The only substituted
// internal primitive is React's scheduler; API, recovery and store remain real.
async function harness() {
  const effects = [];
  globalThis.__todoRecoveryEffect = (run, deps) => effects.push({ run, deps });
  const listeners = new Map();
  const reads = [];
  let read = async () => { throw new Error("host unavailable"); };
  globalThis.window = { piDesktop: {
    invoke: async (channel, input) => {
      assert.equal(channel, IPC.invoke.todosGet);
      reads.push(input.sessionId);
      try { return { ok: true, data: await read(input.sessionId) }; }
      catch (error) { return { ok: false, error: { message: error.message, code: "HOST_UNAVAILABLE" } }; }
    },
    on: (channel, listener) => {
      const bucket = listeners.get(channel) ?? new Set();
      listeners.set(channel, bucket);
      bucket.add(listener);
      return () => bucket.delete(listener);
    },
  } };
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    plugins: [{ name: "todo-effect-scheduler", enforce: "pre", transform(source, id) {
      if (!id.endsWith("/TodoDock.tsx") && !id.endsWith("/useSessionTodosRecovery.ts")) return;
      return source.replace(/import \{ useEffect(?:, useState)? \} from "react";/,
        id.endsWith("/TodoDock.tsx")
          ? 'import { useState } from "react"; const useEffect = globalThis.__todoRecoveryEffect;'
          : 'const useEffect = globalThis.__todoRecoveryEffect;');
    } }],
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const { TodoDock } = await server.ssrLoadModule("/src/components/TodoDock.tsx");
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const { api } = await server.ssrLoadModule("/src/lib/api.ts");
  const offTodos = api.onTodosChanged(useAppStore.getState().applyTodosChanged);
  useAppStore.setState({ sessionTodos: {} });
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  let mounted = [];
  const render = (sessionId) => {
    effects.length = 0;
    Object.assign(useAppStore.getInitialState(), { sessionTodos: useAppStore.getState().sessionTodos });
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(TodoDock, { sessionId })));
    mounted = effects.map((effect, index) => {
      const old = mounted[index];
      if (old && effect.deps.every((dep, i) => Object.is(dep, old.deps[i]))) return old;
      old?.cleanup?.();
      return { ...effect, cleanup: effect.run() };
    });
    return html;
  };
  return {
    render, reads, store: useAppStore,
    setRead: (next) => { read = next; },
    emit: (channel, payload) => { for (const listener of listeners.get(channel) ?? []) listener(payload); },
    settle: async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); },
    close: async () => {
      for (const effect of mounted) effect.cleanup?.();
      offTodos();
      await server.close();
      delete globalThis.window;
      delete globalThis.__todoRecoveryEffect;
    },
    unmount: () => {
      for (const effect of mounted) effect.cleanup?.();
      mounted = [];
    },
    listenerCount: (channel) => listeners.get(channel)?.size ?? 0,
  };
}

const snapshot = (sessionId, revision, content = "Recovered work") => ({
  sessionId, revision, updatedAt: revision,
  todos: [{ content, status: "pending", priority: "medium" }],
});

test("TodoDock recovers a failed first read when the host returns without a session switch", async (t) => {
  const diagnostics = t.mock.method(console, "error", () => undefined);
  const recoveryErrors = () => diagnostics.mock.calls.filter(call => call.arguments[0] === "Session checklist recovery failed");
  const h = await harness();
  try {
    assert.equal(h.render("session-a"), "");
    await h.settle();
    assert.deepEqual(h.reads, ["session-a"]);
    assert.equal(recoveryErrors().length, 1);
    assert.match(recoveryErrors()[0].arguments[1].message, /host unavailable/);
    h.setRead(async (id) => snapshot(id, 1));
    h.emit(IPC.event.hostStatus, { ok: true, component: "host" });
    await h.settle();
    assert.deepEqual(h.reads, ["session-a", "session-a"]);
    assert.match(h.render("session-a"), /Recovered work/);
  } finally { await h.close(); }
});

test("TodoDock re-reads cached sessions on activation and restart without snapshot-driven requests", async () => {
  const h = await harness();
  try {
    h.store.getState().applyTodosChanged(snapshot("session-a", 1, "Cached work"));
    let revision = 2;
    h.setRead(async (id) => snapshot(id, revision++, "Current host work"));
    assert.match(h.render("session-a"), /Cached work/);
    await h.settle();
    assert.match(h.render("session-a"), /Current host work/);
    assert.deepEqual(h.reads, ["session-a"]);
    h.render("session-b");
    await h.settle();
    h.render("session-a");
    await h.settle();
    assert.deepEqual(h.reads, ["session-a", "session-b", "session-a"]);
    h.emit(IPC.event.hostStatus, { ok: true, component: "sidecar", restarted: true });
    assert.equal(h.reads.length, 3);
    h.emit(IPC.event.hostStatus, { ok: true, component: "host", restarted: true });
    await h.settle();
    assert.equal(h.reads.length, 4);
    assert.equal(h.store.getState().sessionTodos["session-a"].revision, 5);
  } finally { await h.close(); }
});

test("TodoDock keeps newer events and drops old-host and switched-session reads", async () => {
  const h = await harness();
  const pending = [];
  h.setRead((id) => new Promise((resolve) => pending.push({ id, resolve })));
  try {
    h.render("session-a");
    h.emit(IPC.event.hostStatus, { ok: false, component: "host" });
    h.emit(IPC.event.hostStatus, { ok: true, component: "host" });
    assert.equal(pending.length, 2);
    pending[1].resolve(snapshot("session-a", 2));
    await h.settle();
    pending[0].resolve(snapshot("session-a", 10, "Obsolete host response"));
    await h.settle();
    assert.equal(h.store.getState().sessionTodos["session-a"].revision, 2);
    h.emit(IPC.event.hostStatus, { ok: true, component: "host", restarted: true });
    h.emit(IPC.event.todosChanged, snapshot("session-a", 4, "New push"));
    pending[2].resolve(snapshot("session-a", 3, "Stale read"));
    await h.settle();
    assert.match(h.render("session-a"), /New push/);
    h.render("session-b");
    h.render("session-a");
    pending[3].resolve(snapshot("session-b", 1));
    pending[4].resolve(snapshot("session-a", 5));
    await h.settle();
    assert.equal(h.store.getState().sessionTodos["session-b"], undefined);
    assert.equal(h.store.getState().sessionTodos["session-a"].revision, 5);
    assert.equal(h.listenerCount(IPC.event.hostStatus), 1);
    h.unmount();
    assert.equal(h.listenerCount(IPC.event.hostStatus), 0);
    h.emit(IPC.event.hostStatus, { ok: true, component: "host", restarted: true });
    assert.equal(h.reads.length, 5);
  } finally { await h.close(); }
});

test("TodoDock never reads the local host for remote or native sessions", async () => {
  const h = await harness();
  try {
    h.render("remote:server:session-a");
    h.render("native-pi:session-a");
    h.emit(IPC.event.hostStatus, { ok: true, component: "host", restarted: true });
    await h.settle();
    assert.deepEqual(h.reads, []);
    assert.equal(h.listenerCount(IPC.event.hostStatus), 0);
  } finally { await h.close(); }
});

test("TodoDock rejects a mismatched snapshot and ignores pending work after unmount", async (t) => {
  const diagnostics = t.mock.method(console, "error", () => undefined);
  const recoveryErrors = () => diagnostics.mock.calls.filter(call => call.arguments[0] === "Session checklist recovery failed");
  const h = await harness();
  const pending = [];
  h.setRead(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
  try {
    h.render("session-a");
    pending[0].resolve(snapshot("different-session", 1));
    await h.settle();
    assert.equal(h.store.getState().sessionTodos["different-session"], undefined);
    assert.equal(recoveryErrors().length, 1);
    h.emit(IPC.event.hostStatus, { ok: true, component: "host", restarted: true });
    h.unmount();
    pending[1].reject(new Error("Disposed read"));
    await h.settle();
    assert.equal(recoveryErrors().length, 1);
    assert.equal(h.listenerCount(IPC.event.hostStatus), 0);
  } finally { await h.close(); }
});
