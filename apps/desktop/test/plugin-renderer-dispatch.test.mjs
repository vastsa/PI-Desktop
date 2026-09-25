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
const { isUserGesture } = await import("../src/plugins/renderer-host/composer-actions.ts");
const { PluginRendererError } = await import("../src/plugins/renderer-error.ts");
const { composerDraftBridge } = await import(
  "../src/features/chat/composer/plugins/draft-bridge.ts"
);
const { IPC } = await import("@pi-desktop/shared");
const { PLUGIN_RENDERER_ACTIONS } = await import("@pi-desktop/plugin-sdk");

const PLUGIN = "demo.lab";
const ALL = [...PLUGIN_RENDERER_ACTIONS];
const MARK = "\uFFFC";

function rejectsWith(code) {
  return (error) => {
    assert.ok(error instanceof PluginRendererError, `expected a PluginRendererError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  };
}

/** Routes that record what reached them. */
function fakeRoutes({ call = async () => ({ ok: true }), composer = {}, gesture = () => false } = {}) {
  const calls = [];
  const reached = [];
  const answer = (name, fallback) => (...args) => {
    reached.push([name, ...args]);
    return (composer[name] ?? fallback)(...args);
  };
  return {
    calls,
    reached,
    routes: {
      pluginCall: (pluginId, method, args) => {
        calls.push({ pluginId, method, args });
        return call(pluginId, method, args);
      },
      composer: {
        insertText: answer("insertText", () => ({ ok: true, generation: 1 })),
        readDraft: answer("readDraft", () => ({ text: "", marks: [], generation: 1 })),
        replaceDraft: answer("replaceDraft", () => ({ ok: true, generation: 2 })),
        addAttachment: answer("addAttachment", async () => ({ id: "a1" })),
        listAttachments: answer("listAttachments", () => []),
        removeAttachment: answer("removeAttachment", () => ({ ok: true })),
      },
      userGesture: gesture,
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
  const { routes, calls, reached } = fakeRoutes();
  const { dispatch } = createDispatchChannel(PLUGIN, ["plugin.call"], routes);

  const refused = dispatch("composer.insertText", { text: "hi" });
  assert.ok(refused instanceof Promise, "refusals reject; dispatch never throws synchronously");
  await assert.rejects(refused, rejectsWith("PLUGIN_ACTION_UNDECLARED"));
  for (const action of ALL.filter((word) => word !== "plugin.call")) {
    await assert.rejects(dispatch(action, {}), rejectsWith("PLUGIN_ACTION_UNDECLARED"), action);
  }
  await assert.rejects(dispatch("ui.toast", { text: "hi" }), rejectsWith("PLUGIN_ACTION_UNKNOWN"));
  await assert.rejects(
    dispatch("composer.acceptTriggerItem", {}),
    rejectsWith("PLUGIN_ACTION_UNKNOWN"),
  );
  await assert.rejects(dispatch(42, {}), rejectsWith("PLUGIN_ACTION_UNKNOWN"));
  await assert.rejects(dispatch(undefined, {}), rejectsWith("PLUGIN_ACTION_UNKNOWN"));
  assert.deepEqual(calls, []);
  assert.deepEqual(reached, []);

  // Declaring a word the host does not implement grants nothing.
  const { dispatch: widened } = createDispatchChannel(PLUGIN, ["ui.toast"], routes);
  await assert.rejects(widened("ui.toast", {}), rejectsWith("PLUGIN_ACTION_UNKNOWN"));
});

test("a payload must be an object of the word's shape", async () => {
  const { routes, calls, reached } = fakeRoutes();
  const { dispatch } = createDispatchChannel(PLUGIN, ALL, routes);
  const invalid = {
    "plugin.call": [undefined, null, "ping", [], [{ method: "ping" }], {}, { method: "" }, { method: 3 }],
    "composer.insertText": [undefined, "hi", ["hi"], {}, { text: "" }, { text: 3 }, { text: ["hi"] }],
    "composer.readDraft": [undefined, null, "draft", []],
    "composer.replaceDraft": [
      {},
      { text: "a" },
      { expectedGeneration: -1, text: "a" },
      { expectedGeneration: 1.5, text: "a" },
      { expectedGeneration: "1", text: "a" },
      { expectedGeneration: 2 ** 53, text: "a" },
      { expectedGeneration: 1 },
      { expectedGeneration: 1, text: 3 },
      { expectedGeneration: 1, text: "a", extra: true },
      { expectedGeneration: 1, text: "a", marks: {} },
      { expectedGeneration: 1, text: MARK },
      { expectedGeneration: 1, text: "a", marks: [{ id: "m" }] },
      { expectedGeneration: 1, text: MARK, marks: [null] },
      { expectedGeneration: 1, text: MARK, marks: ["m"] },
      { expectedGeneration: 1, text: MARK, marks: [{ id: "" }] },
      { expectedGeneration: 1, text: MARK, marks: [{ id: 3 }] },
      { expectedGeneration: 1, text: MARK, marks: [{ id: "m", label: "x" }] },
      { expectedGeneration: 1, text: MARK, marks: [{ label: "" }] },
      { expectedGeneration: 1, text: MARK, marks: [{ label: "a\nb" }] },
      { expectedGeneration: 1, text: MARK, marks: [{ label: "a", send: " " }] },
      { expectedGeneration: 1, text: MARK, marks: [{ label: "a", detail: "d" }] },
      { expectedGeneration: 1, text: MARK, marks: [{ label: "x".repeat(65) }] },
    ],
    "attachments.add": [
      {},
      { name: "a.txt", mimeType: "text/plain" },
      { name: "a.txt", mimeType: "text/plain", content: 3 },
      { name: "a.txt", mimeType: "text/plain", content: [1, 2] },
      { name: "a.txt", mimeType: "text/plain", content: "hi", extra: 1 },
      { name: "a.txt", mimeType: "text/plain", token: "t" },
      { name: "a.txt", mimeType: "text/plain", content: "hi", token: "t" },
      { name: "noext", mimeType: "text/plain", content: "hi" },
      { name: ".txt", mimeType: "text/plain", content: "hi" },
      { name: "dir/a.txt", mimeType: "text/plain", content: "hi" },
      { name: "dir\\a.txt", mimeType: "text/plain", content: "hi" },
      { name: "a\n.txt", mimeType: "text/plain", content: "hi" },
      { name: `${"a".repeat(252)}.txt`, mimeType: "text/plain", content: "hi" },
      { name: 3, mimeType: "text/plain", content: "hi" },
      { name: "a.txt", mimeType: "text", content: "hi" },
      { name: "a.txt", mimeType: "text/plain; charset=utf-8", content: "hi" },
      { name: "a.txt", content: "hi" },
    ],
    "attachments.list": [undefined, []],
    "attachments.remove": [undefined, {}, { id: "" }, { id: 3 }],
  };
  for (const [action, payloads] of Object.entries(invalid)) {
    for (const payload of payloads) {
      await assert.rejects(
        dispatch(action, payload),
        rejectsWith("PLUGIN_ACTION_INVALID_PAYLOAD"),
        `${action} ${JSON.stringify(payload)}`,
      );
    }
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(reached, []);
});

test("composer.insertText takes up to 32KB of UTF-8 and answers with the bridge's result", async () => {
  const { routes, reached } = fakeRoutes({
    composer: { insertText: () => ({ ok: true, generation: 7 }) },
  });
  const { dispatch } = createDispatchChannel(PLUGIN, ["composer.insertText"], routes);

  assert.deepEqual(await dispatch("composer.insertText", { text: "a".repeat(32 * 1024) }), {
    ok: true,
    generation: 7,
  });
  // "\u00E9" is two bytes: the ceiling counts bytes, not characters.
  await dispatch("composer.insertText", { text: "\u00E9".repeat(16 * 1024) });
  await assert.rejects(
    dispatch("composer.insertText", { text: "\u00E9".repeat(16 * 1024 + 1) }),
    rejectsWith("PLUGIN_ACTION_INVALID_PAYLOAD"),
  );
  assert.deepEqual(
    reached.map(([name, text]) => [name, text.length]),
    [
      ["insertText", 32 * 1024],
      ["insertText", 16 * 1024],
    ],
    "only accepted text reaches the composer, unchanged",
  );
});

test("a refusal of the composer bridge rejects the dispatch as it was thrown", async () => {
  const refusal = new PluginRendererError("PLUGIN_ACTION_NO_COMPOSER", "no composer takes input");
  const { routes } = fakeRoutes({
    composer: {
      readDraft: () => {
        throw refusal;
      },
      addAttachment: async () => {
        throw new PluginRendererError("PLUGIN_ATTACHMENT_FAILED", "disk full");
      },
    },
  });
  const { dispatch } = createDispatchChannel(PLUGIN, ALL, routes);
  const read = dispatch("composer.readDraft", {});
  assert.ok(read instanceof Promise, "a throwing route still only rejects");
  await assert.rejects(read, (error) => error === refusal);
  await assert.rejects(
    dispatch("attachments.add", { name: "a.txt", mimeType: "text/plain", content: "hi" }),
    rejectsWith("PLUGIN_ATTACHMENT_FAILED"),
  );
});

test("the read and list words reach the bridge with the plugin's own id", async () => {
  const { routes, reached } = fakeRoutes({
    composer: {
      readDraft: (pluginId) => ({ text: `for ${pluginId}`, marks: [], generation: 3 }),
      listAttachments: () => [{ id: "a1", name: "a.txt", mimeType: "text/plain", size: 2 }],
    },
  });
  const { dispatch } = createDispatchChannel(PLUGIN, ALL, routes);
  assert.deepEqual(await dispatch("composer.readDraft", {}), {
    text: `for ${PLUGIN}`,
    marks: [],
    generation: 3,
  });
  assert.equal((await dispatch("attachments.list", {})).length, 1);
  assert.deepEqual(await dispatch("attachments.remove", { id: "a1" }), { ok: true });
  assert.deepEqual(reached, [
    ["readDraft", PLUGIN],
    ["listAttachments", PLUGIN],
    ["removeAttachment", PLUGIN, "a1"],
  ]);
});

test("composer.replaceDraft hands the bridge checked marks and the gesture at the call", async () => {
  let gesture = true;
  const { routes, reached } = fakeRoutes({ gesture: () => gesture });
  const { dispatch } = createDispatchChannel(PLUGIN, ["composer.replaceDraft"], routes);

  const pending = dispatch("composer.replaceDraft", {
    expectedGeneration: 4,
    text: `a${MARK}b${MARK}`,
    marks: [{ id: "composer-file-1" }, { label: "Issue 7" }],
  });
  // The event is over by the time anything after the call runs.
  gesture = false;
  assert.deepEqual(await pending, { ok: true, generation: 2 });
  await dispatch("composer.replaceDraft", { expectedGeneration: 5, text: "plain" });
  assert.deepEqual(reached, [
    [
      "replaceDraft",
      PLUGIN,
      {
        expectedGeneration: 4,
        text: `a${MARK}b${MARK}`,
        marks: [{ id: "composer-file-1" }, { label: "Issue 7", send: "Issue 7" }],
      },
      true,
    ],
    ["replaceDraft", PLUGIN, { expectedGeneration: 5, text: "plain", marks: [] }, false],
  ]);

  const big = "a".repeat(256 * 1024 + 1);
  await assert.rejects(
    dispatch("composer.replaceDraft", { expectedGeneration: 1, text: big }),
    rejectsWith("PLUGIN_ACTION_INVALID_PAYLOAD"),
  );
  await dispatch("composer.replaceDraft", { expectedGeneration: 1, text: big.slice(1) });
});

test("attachments.add takes the content itself, copied, and refuses a path or URL", async () => {
  const { routes, reached } = fakeRoutes();
  const { dispatch } = createDispatchChannel(PLUGIN, ["attachments.add"], routes);
  const add = (content, name = "a.txt", mimeType = "text/plain") =>
    dispatch("attachments.add", { name, mimeType, content });
  const bytesOf = (index) => [...new Uint8Array(reached[index][2].data)];

  assert.deepEqual(await add("h\u00E9"), { id: "a1" });
  assert.deepEqual(reached[0].slice(0, 2), ["addAttachment", PLUGIN]);
  assert.equal(reached[0][2].name, "a.txt");
  assert.equal(reached[0][2].mimeType, "text/plain");
  assert.deepEqual(bytesOf(0), [0x68, 0xc3, 0xa9], "a string is its UTF-8 bytes");

  const whole = new Uint8Array([9, 1, 2, 3, 9]);
  await add(whole.subarray(1, 4), "chart.png", "image/png");
  assert.deepEqual(bytesOf(1), [1, 2, 3], "a view is only its own bytes");
  const buffer = new Uint8Array([4, 5]).buffer;
  await add(buffer, "b.bin", "application/octet-stream");
  new Uint8Array(buffer)[0] = 0;
  whole[1] = 0;
  assert.deepEqual(bytesOf(2), [4, 5], "the host keeps a copy");
  assert.deepEqual(bytesOf(1), [1, 2, 3]);

  // Text that merely starts like a path is content once it runs over lines.
  await add("/* reset */\nbody { margin: 0 }", "reset.css", "text/css");
  await add("see https://example.com", "note.txt");

  for (const reference of [
    "/etc/passwd",
    "  /tmp/a.png\n",
    "~/notes.txt",
    "./a.txt",
    "../a.txt",
    "C:\\Users\\me\\a.txt",
    "c:/a.txt",
    "\\\\server\\share\\a.txt",
    "file:///etc/passwd",
    "FILE:/etc/passwd",
    "https://example.com/a.png",
    "http:example.com",
    "data:text/plain,hi",
    "blob:https://example.com/1",
    "ftp://example.com/a",
    "s3://bucket/key",
  ]) {
    await assert.rejects(
      add(reference),
      rejectsWith("PLUGIN_ATTACHMENT_REFERENCE_REFUSED"),
      JSON.stringify(reference),
    );
  }
  await assert.rejects(
    add(new Uint8Array(16 * 1024 * 1024 + 1), "big.bin"),
    rejectsWith("PLUGIN_ATTACHMENT_LIMIT"),
  );
  await add(new Uint8Array(16 * 1024 * 1024), "max.bin");
  assert.equal(reached.length, 6);
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
  const later = () => {
    const answer = deferred();
    pending.push(answer);
    return answer.promise;
  };
  const { routes } = fakeRoutes({ call: later, composer: { addAttachment: later } });
  const channel = createDispatchChannel(PLUGIN, ALL, routes);

  const settledFirst = channel.dispatch("plugin.call", { method: "first" });
  pending[0].resolve("before the end");
  assert.equal(await settledFirst, "before the end");

  const late = channel.dispatch("plugin.call", { method: "late" });
  const failing = channel.dispatch("plugin.call", { method: "failing" });
  const staging = channel.dispatch("attachments.add", {
    name: "a.txt",
    mimeType: "text/plain",
    content: "hi",
  });
  channel.close();
  await assert.rejects(late, rejectsWith("PLUGIN_UNLOADED"));
  await assert.rejects(failing, rejectsWith("PLUGIN_UNLOADED"));
  await assert.rejects(staging, rejectsWith("PLUGIN_UNLOADED"));
  // The answers that arrive afterwards go nowhere.
  pending[1].resolve("after the end");
  pending[2].reject(new Error("after the end"));
  pending[3].resolve({ id: "late" });

  await assert.rejects(channel.dispatch("plugin.call", { method: "ping" }), rejectsWith("PLUGIN_UNLOADED"));
  await assert.rejects(channel.dispatch("composer.insertText", { text: "hi" }), rejectsWith("PLUGIN_UNLOADED"));
  await assert.rejects(channel.dispatch("ui.toast", {}), rejectsWith("PLUGIN_UNLOADED"));
  channel.close();
  assert.equal(pending.length, 4, "nothing is relayed once the channel is closed");
});

test("a user gesture is a trusted input event of the running handler", () => {
  for (const type of ["click", "keydown", "pointerup", "input", "change", "submit"]) {
    assert.equal(isUserGesture({ isTrusted: true, type }), true, type);
  }
  assert.equal(isUserGesture({ isTrusted: false, type: "click" }), false, "a synthetic click");
  for (const type of ["load", "message", "focus", "scroll", "mousemove", "transitionend"]) {
    assert.equal(isUserGesture({ isTrusted: true, type }), false, type);
  }
  assert.equal(isUserGesture(undefined), false, "outside any event");
});

test("the default routes reach the draft bridge, the window's event and the main-process relay", async (t) => {
  const originalWindow = globalThis.window;
  t.after(() => {
    globalThis.window = originalWindow;
  });
  const { dispatch } = createDispatchChannel(PLUGIN, ALL);

  await assert.rejects(
    dispatch("composer.insertText", { text: "hi" }),
    rejectsWith("PLUGIN_ACTION_NO_COMPOSER"),
  );
  const writes = [];
  let text = "";
  const handle = {
    read: () => ({ draftKey: "session:s1", sessionId: "s1", text, references: [] }),
    focused: () => false,
    selection: () => ({ start: text.length, end: text.length }),
    write: (next, _references, caret, focus) => writes.push({ next, caret, focus }),
    stage: async () => {
      throw new Error("not staged in this test");
    },
  };
  const unregister = composerDraftBridge.register(handle);
  t.after(unregister);
  const inserted = await dispatch("composer.insertText", { text: "hi" });
  assert.equal(inserted.ok, true);
  assert.deepEqual(writes, [{ next: "hi", caret: 2, focus: true }]);
  text = "hi";
  composerDraftBridge.publish(handle);

  // No window event: the write is remote.
  const { generation } = await dispatch("composer.readDraft", {});
  await assert.rejects(
    dispatch("composer.replaceDraft", { expectedGeneration: generation, text: "x" }),
    rejectsWith("PLUGIN_DRAFT_REMOTE"),
  );
  globalThis.window = { event: { isTrusted: true, type: "click" } };
  assert.equal((await dispatch("composer.replaceDraft", { expectedGeneration: generation, text: "x" })).ok, true);
  assert.equal(writes.at(-1).next, "x");
  unregister();
  await assert.rejects(dispatch("composer.readDraft", {}), rejectsWith("PLUGIN_ACTION_NO_COMPOSER"));

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
