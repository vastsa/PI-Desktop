import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("helpers/ts-import-hooks.mjs", import.meta.url));
const module = await import("../src/features/app/plugin-shell-layout-controller.ts");
function fixture() {
  let now = 100;
  let state = {
    contextId: "c1", sessionId: "s1", projectPath: null, settled: true,
    layout: { sidebar: { collapsed: false, width: 280, minWidth: 240, maxWidth: 520 }, workPanel: { visible: false, width: 360, minWidth: 244, tabs: [], activeTabId: null } },
  };
  const published = [], responses = [], applied = [], errors = [];
  assert.equal(typeof module.createPluginShellLayoutController, "function");
  const controller = module.createPluginShellLayoutController({
    bootId: "b1", now: () => now, read: () => structuredClone(state),
    apply: (command, expected) => {
      assert.equal(expected, state.contextId);
      applied.push(command);
      const width = command.input?.width;
      if (width === undefined || width === state.layout.sidebar.width) return false;
      state.layout.sidebar.width = width;
      return true;
    },
    publish: async (snapshot) => published.push(snapshot),
    respond: async (response) => responses.push(response),
    reportError: (error) => errors.push(error),
  });
  const request = (id, command = { kind: "get" }, extra = {}) => controller.receive({ requestId: id, bootId: "b1", contextId: "c1", expiresAt: 1000, command, ...extra });
  return { controller, request, published, responses, applied, errors, state, advance: () => { now = 1001; } };
}

test("initial stable snapshot and identical commits produce one publication", () => {
  const f = fixture();
  f.controller.committed();
  f.controller.committed();
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0].bootId, "b1");
});

test("live drag reads do not publish preview pixels; drag completion publishes once", () => {
  const f = fixture();
  f.controller.committed();
  f.state.settled = false;
  f.state.layout.sidebar.width = 300;
  f.controller.committed();
  f.request("read-drag");
  assert.equal(f.responses[0].snapshot.layout.sidebar.width, 300);
  assert.equal(f.published.length, 1);
  f.state.layout.sidebar.width = 320;
  f.controller.committed();
  assert.equal(f.published.length, 1);
  f.state.settled = true;
  f.controller.committed();
  f.controller.committed();
  assert.equal(f.published.length, 2);
  assert.equal(f.published[1].layout.sidebar.width, 320);
  assert.ok(f.published[1].revision > f.responses[0].snapshot.revision);
});

test("mutation returns after its actual commit and publishes only the resulting layout", () => {
  const f = fixture();
  f.controller.committed();
  f.request("write", { kind: "setSidebar", input: { width: 400 } });
  assert.equal(f.responses.length, 0);
  f.controller.notify();
  assert.equal(f.responses.length, 0, "child geometry alone must not acknowledge a pending parent update");
  f.controller.committed();
  assert.equal(f.responses[0].snapshot.layout.sidebar.width, 400);
  assert.equal(f.published.length, 2);
  f.request("noop", { kind: "setSidebar", input: { width: 400 } });
  assert.equal(f.responses.length, 2);
  assert.equal(f.published.length, 2);
});

test("queued writes are cancelled before applying on timeout, unload or context switch", () => {
  const f = fixture();
  f.state.settled = false;
  f.request("unloaded", { kind: "setSidebar", input: { width: 400 } });
  f.controller.receive({ kind: "cancel", requestId: "unloaded" });
  f.request("timeout", { kind: "setSidebar", input: { width: 410 } });
  f.advance();
  f.state.settled = true;
  f.controller.committed();
  assert.equal(f.applied.length, 0);
  assert.equal(f.responses[0].error.code, "UNAVAILABLE");
  f.request("stale", { kind: "setSidebar", input: { width: 420 } }, { expiresAt: 2000, contextId: "old" });
  assert.match(f.responses[1].error.message, /context changed/i);
  assert.equal(f.applied.length, 0);
});

test("multiple setters serialize through separate commits", () => {
  const f = fixture();
  f.request("first", { kind: "setSidebar", input: { width: 400 } });
  f.request("second", { kind: "setSidebar", input: { width: 450 } });
  assert.equal(f.applied.length, 1);
  f.controller.committed();
  assert.equal(f.responses[0].snapshot.layout.sidebar.width, 400);
  assert.equal(f.applied.length, 2);
  assert.equal(f.responses.length, 1);
  f.controller.committed();
  assert.equal(f.responses[1].snapshot.layout.sidebar.width, 450);
});

test("dispose rejects pending work and detaches future messages", () => {
  const f = fixture();
  f.state.settled = false;
  f.request("pending", { kind: "setSidebar", input: { width: 400 } });
  f.controller.dispose();
  assert.equal(f.responses[0].error.code, "UNAVAILABLE");
  f.controller.committed();
  f.request("later");
  assert.equal(f.applied.length, 0);
  assert.equal(f.responses.length, 1);
});
