import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createCatalogSlice } = await import("../src/stores/slices/catalog-slice.ts");
const { createCatalogRuntime } = await import("../src/stores/runtime/catalog-runtime.ts");
const { api } = await import("../src/lib/api.ts");

test("provider refresh retains the active remote identity when its host temporarily disappears", async t => {
  const remote = { id: "remote:fixture", source: "remote", projectPath: "/unsafe-remote-path", remoteProjectId: "project", capabilities: { canPrompt: true, canStop: true } };
  let state = { activeSessionId: remote.id, sessions: [remote], sessionMeta: {}, providerModels: {} };
  const slice = createCatalogSlice({ catalogRuntime: createCatalogRuntime(), get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; }, decorateSessions: sessions => sessions });
  t.mock.method(api, "listProviders", async () => ({ providers: [] }));
  t.mock.method(api, "listSessions", async () => ({ sessions: [] }));
  t.mock.method(api, "getSettings", async () => ({}));
  t.mock.method(api, "getOnboarding", async () => ({}));
  await slice.refreshProviders();
  assert.equal(state.sessions[0]?.id, remote.id);
  assert.equal(state.sessions[0]?.source, "remote");
  assert.equal(state.sessions[0]?.projectPath, undefined);
  assert.equal(state.sessions[0]?.remoteProjectId, "project");
});

test("an authoritative returned remote summary replaces the retained one", async t => {
  const before = { id: "remote:fixture", source: "remote", capabilities: { canStop: true } };
  const after = { ...before, title: "current", projectPath: "/remote", capabilities: { canStop: false } };
  let state = { activeSessionId: before.id, sessions: [before], sessionMeta: {} };
  const slice = createCatalogSlice({ catalogRuntime: createCatalogRuntime(), get: () => state, set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; }, decorateSessions: sessions => sessions });
  t.mock.method(api, "listProviders", async () => ({ providers: [] }));
  t.mock.method(api, "listSessions", async () => ({ sessions: [after] }));
  t.mock.method(api, "getSettings", async () => ({}));
  t.mock.method(api, "getOnboarding", async () => ({}));
  await slice.refreshProviders();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].title, "current");
  assert.equal(state.sessions[0].capabilities.canStop, false);
  assert.equal(state.sessions[0].projectPath, undefined);
});
