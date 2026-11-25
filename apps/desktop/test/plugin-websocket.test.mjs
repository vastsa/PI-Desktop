/**
 * Plugin real-time connections (permission `net.websocket`).
 *
 * The registry is driven by a fake transport, so the bounds, the ownership
 * rules and the release paths are asserted without a network. One case then
 * drives the real `ws` factory against a loopback server, because the framing
 * and the binary payload are the parts a fake cannot vouch for.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "..", "electron/main/plugin-host-process.mjs");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const {
  MAX_FRAME_BYTES,
  MAX_SOCKETS_PER_PLUGIN,
  PluginSocketError,
  PluginWebSocketRegistry,
} = await import("../electron/main/plugin-websocket.ts");

// Set before the runtime is imported so nothing a host call touches can land in
// the developer's real data directory.
const dataDir = mkdtempSync(join(tmpdir(), "pi-websocket-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const PLUGIN_ID = "com.example.voice";
const OTHER_PLUGIN = "com.example.other";

/**
 * A transport that records what the host asked of it and lets a test drive the
 * lifecycle by hand: no sockets, no timers, no I/O.
 */
function fakeTransport({ refuseFrameOver = Infinity } = {}) {
  const opened = [];
  const calls = { sends: [], closes: [], terminates: [] };
  const factory = (init, handlers) => {
    const socket = {
      url: init.url,
      handlers,
      buffered: 0,
      send: (data) => {
        const size = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        if (size > refuseFrameOver) {
          calls.sends.push({ data, oversized: true });
          return;
        }
        calls.sends.push({ data });
      },
      close: (code, reason) => calls.closes.push({ code, reason }),
      terminate: () => calls.terminates.push(init.url),
      bufferedAmount: () => socket.buffered,
    };
    opened.push(socket);
    return socket;
  };
  return { factory, opened, calls };
}

/** Settle a `connect` that is waiting for its open event. */
function openLast(transport, protocol = "") {
  const socket = transport.opened.at(-1);
  socket.handlers.onOpen({ protocol });
  return socket;
}

function refusal(run, code) {
  assert.throws(run, (error) => {
    assert.ok(
      error instanceof PluginSocketError,
      `expected PluginSocketError, got ${error}`,
    );
    assert.equal(error.code, code);
    return true;
  });
}

test("connect resolves once the socket opens and reports it to the owner", async () => {
  const transport = fakeTransport();
  const events = [];
  const registry = new PluginWebSocketRegistry({
    createSocket: transport.factory,
    onEvent: (pluginId, event) => events.push({ pluginId, event }),
  });

  const pending = registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" });
  openLast(transport, "voice.v1");
  const { socketId } = await pending;

  assert.deepEqual(events, [{ pluginId: PLUGIN_ID, event: { type: "open", socketId, protocol: "voice.v1" } }]);
  assert.deepEqual(
    registry.list(PLUGIN_ID).map((entry) => [entry.state, entry.url]),
    [["open", "wss://voice.example.com/live"]],
  );
  assert.deepEqual(registry.list(OTHER_PLUGIN), []);
});

test("a non-websocket scheme is refused before the transport is used", async () => {
  const transport = fakeTransport();
  const registry = new PluginWebSocketRegistry({ createSocket: transport.factory, onEvent: () => {} });

  await assert.rejects(
    registry.connect({ pluginId: PLUGIN_ID, url: "https://voice.example.com/live" }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    registry.connect({ pluginId: PLUGIN_ID, url: "not a url" }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
  assert.equal(transport.opened.length, 0);
});

test("a connection that closes before opening fails and keeps no slot", async () => {
  const transport = fakeTransport();
  const registry = new PluginWebSocketRegistry({ createSocket: transport.factory, onEvent: () => {} });

  const pending = registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" });
  transport.opened.at(-1).handlers.onClose({ code: 1006, reason: "refused", wasClean: false });
  await assert.rejects(pending, (error) => error.code === "CONNECT_FAILED");

  // The budget is intact: the next connect is not treated as the second socket.
  const retry = registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" });
  openLast(transport);
  await retry;
  assert.equal(registry.list(PLUGIN_ID).length, 1);
});

test("a socket budget is per plugin and refuses rather than evicting", async () => {
  const transport = fakeTransport();
  const registry = new PluginWebSocketRegistry({ createSocket: transport.factory, onEvent: () => {} });

  for (let index = 0; index < MAX_SOCKETS_PER_PLUGIN; index += 1) {
    const pending = registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" });
    openLast(transport);
    await pending;
  }
  await assert.rejects(
    registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" }),
    (error) => error.code === "LIMIT_EXCEEDED",
  );
  // Another plugin still gets its own budget.
  const other = registry.connect({ pluginId: OTHER_PLUGIN, url: "wss://voice.example.com/live" });
  openLast(transport);
  await other;
  assert.equal(registry.list(OTHER_PLUGIN).length, 1);
});

test("send is refused for an unknown socket and for another plugin's socket", async () => {
  const transport = fakeTransport();
  const registry = new PluginWebSocketRegistry({ createSocket: transport.factory, onEvent: () => {} });

  const pending = registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" });
  const { socketId } = await (async () => {
    openLast(transport);
    return pending;
  })();

  refusal(
    () => registry.send({ pluginId: PLUGIN_ID, socketId: "ws-guessed", data: "hi" }),
    "NOT_FOUND",
  );
  // Ownership is by plugin id, not by socket id: a guessed id from a plugin
  // that does not own the socket must not reach it either.
  refusal(
    () => registry.send({ pluginId: OTHER_PLUGIN, socketId, data: "hi" }),
    "NOT_FOUND",
  );
  registry.send({ pluginId: PLUGIN_ID, socketId, data: "hi" });
  assert.deepEqual(transport.calls.sends, [{ data: "hi" }]);
});

test("an oversized frame and a full send queue are refused, not buffered", async () => {
  const transport = fakeTransport();
  const registry = new PluginWebSocketRegistry({
    createSocket: transport.factory,
    onEvent: () => {},
    maxBufferedBytes: 4,
  });

  const pending = registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" });
  const { socketId } = await (async () => {
    openLast(transport);
    return pending;
  })();

  refusal(
    () => registry.send({ pluginId: PLUGIN_ID, socketId, data: new Uint8Array(MAX_FRAME_BYTES + 1) }),
    "LIMIT_EXCEEDED",
  );
  transport.opened.at(-1).buffered = 4;
  refusal(
    () => registry.send({ pluginId: PLUGIN_ID, socketId, data: "x" }),
    "LIMIT_EXCEEDED",
  );
  assert.deepEqual(transport.calls.sends, []);
});

test("an oversized inbound frame closes the connection and reports why", async () => {
  const transport = fakeTransport();
  const events = [];
  const registry = new PluginWebSocketRegistry({
    createSocket: transport.factory,
    onEvent: (pluginId, event) => events.push(event),
  });

  const pending = registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" });
  const socket = openLast(transport);
  const { socketId } = await pending;

  socket.handlers.onMessage(new Uint8Array(MAX_FRAME_BYTES + 1));
  assert.deepEqual(events.at(-1), {
    type: "error",
    socketId,
    code: "OVERSIZED_FRAME",
    message: `frame of ${MAX_FRAME_BYTES + 1} bytes; the connection was closed`,
  });
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  assert.deepEqual(transport.calls.terminates, ["wss://voice.example.com/live"]);
});

test("binary frames reach the owner unchanged", async () => {
  const transport = fakeTransport();
  const events = [];
  const registry = new PluginWebSocketRegistry({
    createSocket: transport.factory,
    onEvent: (pluginId, event) => events.push({ pluginId, event }),
  });

  const pending = registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" });
  const socket = openLast(transport);
  const { socketId } = await pending;

  const frame = new Uint8Array([1, 2, 3, 4]);
  socket.handlers.onMessage(frame);
  socket.handlers.onMessage("text frame");

  assert.deepEqual(events.slice(1), [
    { pluginId: PLUGIN_ID, event: { type: "message", socketId, data: frame } },
    { pluginId: PLUGIN_ID, event: { type: "message", socketId, data: "text frame" } },
  ]);
});

test("a remote close reaches the owner and frees the slot", async () => {
  const transport = fakeTransport();
  const events = [];
  const registry = new PluginWebSocketRegistry({
    createSocket: transport.factory,
    onEvent: (pluginId, event) => events.push({ pluginId, event }),
  });

  const pending = registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" });
  const socket = openLast(transport);
  const { socketId } = await pending;

  socket.handlers.onClose({ code: 1000, reason: "bye", wasClean: true });
  assert.deepEqual(events.at(-1), {
    pluginId: PLUGIN_ID,
    event: { type: "close", socketId, code: 1000, reason: "bye", wasClean: true },
  });
  assert.deepEqual(registry.list(PLUGIN_ID), []);
});

test("releasePlugin terminates every socket of that plugin only", async () => {
  const transport = fakeTransport();
  const registry = new PluginWebSocketRegistry({ createSocket: transport.factory, onEvent: () => {} });

  for (const pluginId of [PLUGIN_ID, OTHER_PLUGIN]) {
    const pending = registry.connect({ pluginId, url: `wss://voice.example.com/${pluginId}` });
    openLast(transport);
    await pending;
  }

  registry.releasePlugin(PLUGIN_ID);
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  assert.deepEqual(transport.calls.terminates, [`wss://voice.example.com/${PLUGIN_ID}`]);
  assert.equal(registry.list(OTHER_PLUGIN).length, 1);

  // Releasing an unknown plugin is a no-op, and the freed slot is reusable.
  registry.releasePlugin("com.example.never-loaded");
  const again = registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" });
  openLast(transport);
  await again;
  assert.equal(registry.list(PLUGIN_ID).length, 1);
});

test("a timed-out connect refuses and leaves nothing behind", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const transport = fakeTransport();
  const registry = new PluginWebSocketRegistry({
    createSocket: transport.factory,
    onEvent: () => {},
    connectTimeoutMs: 20,
  });

  const rejected = assert.rejects(
    registry.connect({ pluginId: PLUGIN_ID, url: "wss://voice.example.com/live" }),
    (error) => error.code === "TIMEOUT",
  );
  t.mock.timers.tick(20);
  await rejected;
  assert.deepEqual(registry.list(PLUGIN_ID), []);
  assert.deepEqual(transport.calls.terminates, ["wss://voice.example.com/live"]);
});

// --- the real transport -----------------------------------------------------

test("the real ws transport carries text and binary frames over loopback", async (t) => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  t.after(() => server.close());

  const received = [];
  server.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      received.push(isBinary ? new Uint8Array(data) : data.toString());
      // Echo back with the same framing, which is what a real-time endpoint does.
      socket.send(data, { binary: isBinary });
    });
  });

  const events = [];
  const registry = new PluginWebSocketRegistry({
    onEvent: (_pluginId, event) => events.push(event),
    connectTimeoutMs: 5_000,
  });
  const { socketId } = await registry.connect({
    pluginId: PLUGIN_ID,
    url: `ws://127.0.0.1:${port}/live`,
    headers: { "x-plugin-test": "1" },
  });

  registry.send({ pluginId: PLUGIN_ID, socketId, data: "hello" });
  registry.send({ pluginId: PLUGIN_ID, socketId, data: new Uint8Array([7, 8, 9]) });

  await waitFor(() => events.filter((event) => event.type === "message").length >= 2);
  const messages = events.filter((event) => event.type === "message");
  assert.deepEqual(received, ["hello", new Uint8Array([7, 8, 9])]);
  assert.deepEqual(messages[0].data, "hello");
  // Binary frames arrive as bytes, not as a serialized object.
  assert.ok(messages[1].data instanceof Uint8Array);
  assert.deepEqual([...messages[1].data], [7, 8, 9]);

  registry.releasePlugin(PLUGIN_ID);
  await waitFor(() =>
    server.clients.size === 0 || [...server.clients].every((client) => client.readyState > 1),
  );
  assert.deepEqual(registry.list(PLUGIN_ID), []);
});

/** Poll until `check` holds; the transports here settle in microseconds. */
async function waitFor(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met before the timeout");
}

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

/** A plugin whose panel channels exercise the three socket host calls. */
const PLUGIN_MAIN = `
  async function attempt(fn) {
    try {
      return { ok: true, value: (await fn()) ?? null };
    } catch (error) {
      return { ok: false, code: error?.code ?? "UNKNOWN", message: String(error?.message ?? "") };
    }
  }
  module.exports = {
    async onPanelInvoke(channel, payload) {
      if (channel === "connect") {
        return attempt(() => pi.net.websocket.connect({ url: payload.url }));
      }
      if (channel === "send") {
        return attempt(() => pi.net.websocket.send({ socketId: payload.socketId, data: "ping" }));
      }
      if (channel === "close") {
        return attempt(() => pi.net.websocket.close({ socketId: payload.socketId }));
      }
      throw new Error("unknown channel: " + channel);
    },
  };
`;

function writePlugin(t, { permissions = ["net.websocket"], net, main = PLUGIN_MAIN } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-websocket-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PLUGIN_ID,
      name: "Voice Plugin",
      version: "0.0.1",
      main: "main.js",
      permissions,
      ...(net ? { net } : {}),
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

/** Records what the broker hands the socket layer, without opening anything. */
function createSocketStub() {
  const calls = { connect: [], send: [], close: [], released: [] };
  return {
    calls,
    connect: (request) => {
      calls.connect.push(request);
      return Promise.resolve({ socketId: "ws-stub-1" });
    },
    send: (request) => {
      calls.send.push(request);
    },
    close: (request) => {
      calls.close.push(request);
    },
    releasePlugin: (pluginId) => {
      calls.released.push(pluginId);
    },
    list: () => [],
  };
}

function createRuntime(t, { pluginSockets } = {}) {
  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    audit: (entry) => audits.push(entry),
    ...(pluginSockets ? { pluginSockets } : {}),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits };
}

test("a plugin without net.websocket cannot connect, and the attempt is audited", async (t) => {
  const sockets = createSocketStub();
  const { runtime, audits } = createRuntime(t, { pluginSockets: sockets });
  const dir = writePlugin(t, { permissions: [], net: { domains: ["voice.example.com"] } });

  await runtime.loadFromPath(dir);
  const answer = await runtime.invokePanelBridge(PLUGIN_ID, "connect", {
    url: "wss://voice.example.com/live",
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, "PERMISSION_DENIED");
  assert.deepEqual(sockets.calls.connect, []);
  // The gateway audits a refusal under the permission it asked for, which is
  // how every other ungranted call is recorded.
  assert.deepEqual(
    audits
      .filter((entry) => entry.api === "net.websocket")
      .map((entry) => (entry.ok ? "ok" : entry.errorCode)),
    ["PERMISSION_DENIED"],
  );
});

test("a host outside manifest.net.domains never reaches the socket layer", async (t) => {
  const sockets = createSocketStub();
  const { runtime, audits } = createRuntime(t, { pluginSockets: sockets });
  const dir = writePlugin(t, { net: { domains: ["voice.example.com"] } });

  await runtime.loadFromPath(dir);
  const denied = await runtime.invokePanelBridge(PLUGIN_ID, "connect", {
    url: "wss://api.openai.com/v1/realtime",
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "PERMISSION_DENIED");
  assert.match(denied.message, /host not in manifest\.net\.domains/);
  // The declared host is still reachable, so the refusal is the allowlist and
  // not a blanket denial.
  const allowed = await runtime.invokePanelBridge(PLUGIN_ID, "connect", {
    url: "wss://voice.example.com/live",
  });
  assert.deepEqual(allowed, { ok: true, value: { socketId: "ws-stub-1" } });
  assert.deepEqual(
    sockets.calls.connect.map((call) => call.url),
    ["wss://voice.example.com/live"],
  );

  // The plugin's own frames route through the broker with its id attached.
  assert.deepEqual(await runtime.invokePanelBridge(PLUGIN_ID, "send", { socketId: "ws-stub-1" }), {
    ok: true,
    value: { ok: true },
  });
  assert.deepEqual(await runtime.invokePanelBridge(PLUGIN_ID, "close", { socketId: "ws-stub-1" }), {
    ok: true,
    value: { ok: true },
  });
  assert.deepEqual(
    sockets.calls.send.map((call) => [call.pluginId, call.socketId, call.data]),
    [[PLUGIN_ID, "ws-stub-1", "ping"]],
  );
  assert.deepEqual(
    sockets.calls.close.map((call) => [call.pluginId, call.socketId]),
    [[PLUGIN_ID, "ws-stub-1"]],
  );
});

test("unloading a plugin releases its sockets", async (t) => {
  const sockets = createSocketStub();
  const { runtime } = createRuntime(t, { pluginSockets: sockets });
  const dir = writePlugin(t, { net: { domains: ["voice.example.com"] } });

  await runtime.loadFromPath(dir);
  await runtime.invokePanelBridge(PLUGIN_ID, "connect", { url: "wss://voice.example.com/live" });
  await runtime.unload(PLUGIN_ID);
  // Unload and the child's exit both run the same cleanup, so the release is
  // idempotent: what matters is that this plugin was released and no other was.
  assert.ok(sockets.calls.released.includes(PLUGIN_ID));
  assert.deepEqual([...new Set(sockets.calls.released)], [PLUGIN_ID]);
});

test("socket events are delivered to the owning plugin only", async (t) => {
  const sockets = createSocketStub();
  const { runtime } = createRuntime(t, { pluginSockets: sockets });
  const dir = writePlugin(t, { net: { domains: ["voice.example.com"] } });
  await runtime.loadFromPath(dir);

  // The event is addressed to the owner: an unloaded plugin id is dropped, and
  // delivery for the loaded owner does not throw.
  assert.doesNotThrow(() =>
    runtime.deliverSocketEvent(PLUGIN_ID, {
      type: "message",
      socketId: "ws-stub-1",
      data: "pong",
    }),
  );
  assert.doesNotThrow(() =>
    runtime.deliverSocketEvent("com.example.not-loaded", {
      type: "close",
      socketId: "ws-stub-2",
      code: 1000,
      reason: "done",
      wasClean: true,
    }),
  );
});
