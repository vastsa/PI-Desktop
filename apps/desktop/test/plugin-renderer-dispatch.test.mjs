import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * `pi.dispatch`, the only outbound channel of plugin renderer code
 * (`docs/plugin-plan/slot-contract.html` §3): which words pass, what their
 * payloads must look like, where each word goes, and that the end of a load
 * cuts the channel off, answers in flight included.
 */
const { createDispatchChannel } = await import("../src/plugins/renderer-host/dispatch.ts");
const { PluginRendererError } = await import("../src/plugins/renderer-error.ts");
const { registerComposerInsert, resetComposerInsertBridge } = await import(
  "../src/features/chat/composer/insert-bridge.ts"
);
const { IPC } = await import("@pi-desktop/shared");

const PLUGIN = "demo.lab";
const BOTH = ["plugin.call", "composer.insertText"];

function rejectsWith(code) {
  return (error) => {
    assert.ok(error instanceof PluginRendererError, `expected a PluginRendererError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  };
}

/** Routes that record what reached them. */
function fakeRoutes({ call = async () => ({ ok: true }), insert = () => true } = {}) {
  const calls = [];
  const inserts = [];
  return {
    calls,
    inserts,
    routes: {
      pluginCall: (pluginId, method, args) => {
        calls.push({ pluginId, method, args });
        return call(pluginId, method, args);
      },
      insertText: (text) => {
        inserts.push(text);
        return insert(text);
      },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("a word outside the vocabulary or the manifest is refused before any route runs", async () => {
  const { routes, calls, inserts } = fakeRoutes();
  const { dispatch } = createDispatchChannel(PLUGIN, ["plugin.call"], routes);

  const refused = dispatch("composer.insertText", { text: "hi" });
  assert.ok(refused instanceof Promise, "refusals reject; dispatch never throws synchronously");
  await assert.rejects(refused, rejectsWith("PLUGIN_ACTION_UNDECLARED"));
  await assert.rejects(dispatch("ui.toast", { text: "hi" }), rejectsWith("PLUGIN_ACTION_UNKNOWN"));
  await assert.rejects(dispatch(42, {}), rejectsWith("PLUGIN_ACTION_UNKNOWN"));
  await assert.rejects(dispatch(undefined, {}), rejectsWith("PLUGIN_ACTION_UNKNOWN"));
  assert.deepEqual(calls, []);
  assert.deepEqual(inserts, []);

  // Declaring a word the host does not implement grants nothing.
  const { dispatch: widened } = createDispatchChannel(PLUGIN, ["ui.toast"], routes);
  await assert.rejects(widened("ui.toast", {}), rejectsWith("PLUGIN_ACTION_UNKNOWN"));
});

test("a payload must be an object of the word's shape", async () => {
  const { routes, calls, inserts } = fakeRoutes();
  const { dispatch } = createDispatchChannel(PLUGIN, BOTH, routes);
  for (const payload of [undefined, null, "ping", [], [{ method: "ping" }], {}, { method: "" }, { method: 3 }]) {
    await assert.rejects(
      dispatch("plugin.call", payload),
      rejectsWith("PLUGIN_ACTION_INVALID_PAYLOAD"),
      `plugin.call ${JSON.stringify(payload)}`,
    );
  }
  for (const payload of [undefined, "hi", ["hi"], {}, { text: "" }, { text: 3 }, { text: ["hi"] }]) {
    await assert.rejects(
      dispatch("composer.insertText", payload),
      rejectsWith("PLUGIN_ACTION_INVALID_PAYLOAD"),
      `composer.insertText ${JSON.stringify(payload)}`,
    );
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(inserts, []);
});

test("composer.insertText takes up to 32KB of UTF-8 and answers ok, or NO_COMPOSER", async () => {
  const { routes, inserts } = fakeRoutes();
  const { dispatch } = createDispatchChannel(PLUGIN, ["composer.insertText"], routes);

  assert.deepEqual(await dispatch("composer.insertText", { text: "a".repeat(32 * 1024) }), { ok: true });
  // "é" is two bytes: the ceiling counts bytes, not characters.
  assert.deepEqual(await dispatch("composer.insertText", { text: "é".repeat(16 * 1024) }), { ok: true });
  await assert.rejects(
    dispatch("composer.insertText", { text: "é".repeat(16 * 1024 + 1) }),
    rejectsWith("PLUGIN_ACTION_INVALID_PAYLOAD"),
  );
  assert.deepEqual(
    inserts.map((text) => text.length),
    [32 * 1024, 16 * 1024],
    "only accepted text reaches the composer, unchanged",
  );

  const { routes: noComposer } = fakeRoutes({ insert: () => false });
  const { dispatch: unmounted } = createDispatchChannel(PLUGIN, ["composer.insertText"], noComposer);
  await assert.rejects(
    unmounted("composer.insertText", { text: "hi" }),
    rejectsWith("PLUGIN_ACTION_NO_COMPOSER"),
  );
});

test("plugin.call relays the plugin's own id and the JSON reading of its args", async () => {
  const { routes, calls } = fakeRoutes({ call: async (_id, method) => ({ answered: method }) });
  const { dispatch } = createDispatchChannel(PLUGIN, ["plugin.call"], routes);

  assert.deepEqual(
    await dispatch("plugin.call", {
      method: "echo",
      args: { at: new Date(0), skipped: undefined, list: [1, undefined], n: 1 },
    }),
    { answered: "echo" },
  );
  assert.deepEqual(await dispatch("plugin.call", { method: "ping" }), { answered: "ping" });
  assert.deepEqual(calls, [
    {
      pluginId: PLUGIN,
      method: "echo",
      args: { at: "1970-01-01T00:00:00.000Z", list: [1, null], n: 1 },
    },
    { pluginId: PLUGIN, method: "ping", args: undefined },
  ]);

  const cyclic = {};
  cyclic.self = cyclic;
  for (const args of [cyclic, { big: 1n }, () => "not data"]) {
    await assert.rejects(
      dispatch("plugin.call", { method: "echo", args }),
      rejectsWith("PLUGIN_CALL_UNSERIALIZABLE"),
    );
  }
  assert.equal(calls.length, 2, "unserializable args never leave the renderer");
});

test("plugin.call passes the relay's coded refusal through untouched", async () => {
  const refusal = Object.assign(new Error("slow down"), { code: "PLUGIN_CALL_RATE_LIMITED" });
  const { routes } = fakeRoutes({ call: async () => Promise.reject(refusal) });
  const { dispatch } = createDispatchChannel(PLUGIN, ["plugin.call"], routes);
  await assert.rejects(dispatch("plugin.call", { method: "ping" }), (error) => error === refusal);
});

test("closing the channel rejects the calls in flight and refuses every later dispatch", async () => {
  const pending = [];
  const { routes } = fakeRoutes({
    call: () => {
      const answer = deferred();
      pending.push(answer);
      return answer.promise;
    },
  });
  const channel = createDispatchChannel(PLUGIN, BOTH, routes);

  const settledFirst = channel.dispatch("plugin.call", { method: "first" });
  pending[0].resolve("before the end");
  assert.equal(await settledFirst, "before the end");

  const late = channel.dispatch("plugin.call", { method: "late" });
  const failing = channel.dispatch("plugin.call", { method: "failing" });
  channel.close();
  await assert.rejects(late, rejectsWith("PLUGIN_UNLOADED"));
  await assert.rejects(failing, rejectsWith("PLUGIN_UNLOADED"));
  // The answers that arrive afterwards go nowhere.
  pending[1].resolve("after the end");
  pending[2].reject(new Error("after the end"));

  await assert.rejects(channel.dispatch("plugin.call", { method: "ping" }), rejectsWith("PLUGIN_UNLOADED"));
  await assert.rejects(channel.dispatch("composer.insertText", { text: "hi" }), rejectsWith("PLUGIN_UNLOADED"));
  await assert.rejects(channel.dispatch("ui.toast", {}), rejectsWith("PLUGIN_UNLOADED"));
  channel.close();
  assert.equal(pending.length, 3, "nothing is relayed once the channel is closed");
});

test("the default routes reach the composer insert bridge and the main-process relay", async (t) => {
  const originalWindow = globalThis.window;
  t.after(() => {
    resetComposerInsertBridge();
    globalThis.window = originalWindow;
  });
  const { dispatch } = createDispatchChannel(PLUGIN, BOTH);

  resetComposerInsertBridge();
  await assert.rejects(
    dispatch("composer.insertText", { text: "hi" }),
    rejectsWith("PLUGIN_ACTION_NO_COMPOSER"),
  );
  const inserted = [];
  registerComposerInsert((text) => inserted.push(text));
  assert.deepEqual(await dispatch("composer.insertText", { text: "hi" }), { ok: true });
  assert.deepEqual(inserted, ["hi"]);
  registerComposerInsert(null);
  await assert.rejects(
    dispatch("composer.insertText", { text: "again" }),
    rejectsWith("PLUGIN_ACTION_NO_COMPOSER"),
  );

  const invoked = [];
  let reply = { ok: true, data: { pong: true } };
  globalThis.window = {
    piDesktop: {
      invoke: async (channel, ...args) => {
        invoked.push([channel, ...args]);
        return reply;
      },
    },
  };
  assert.deepEqual(await dispatch("plugin.call", { method: "ping", args: { n: 1 } }), { pong: true });
  assert.deepEqual(invoked, [[IPC.invoke.pluginRendererCall, PLUGIN, "ping", { n: 1 }]]);

  reply = { ok: false, error: { code: "PLUGIN_CALL_TIMEOUT", message: "no answer within 2000ms" } };
  await assert.rejects(dispatch("plugin.call", { method: "ping" }), (error) => {
    assert.equal(error.code, "PLUGIN_CALL_TIMEOUT");
    assert.equal(error.message, "no answer within 2000ms");
    return true;
  });
});
