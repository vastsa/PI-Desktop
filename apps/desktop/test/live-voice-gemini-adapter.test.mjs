import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

async function fixture(t, respond) {
  const key = `gemini-adapter-${crypto.randomUUID()}`;
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.bufferedAmount = 0;
  socket.sent = [];
  socket.send = (body, callback) => {
    const message = JSON.parse(body);
    socket.sent.push(message);
    queueMicrotask(() => { callback?.(); respond?.(socket, message); });
  };
  socket.close = () => { socket.readyState = 3; socket.emit("close", 1000, Buffer.from("call ended")); };
  globalThis[key] = async () => socket;
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: "gemini-transport-fixture", enforce: "pre",
      resolveId(source) {
        if (source === "./websocket-transport") return "\0gemini-transport-fixture";
      },
      load(id) {
        if (id === "\0gemini-transport-fixture") return `export const openLiveWebSocket = () => globalThis[${JSON.stringify(key)}]();`;
      },
    }],
  });
  const { createGeminiAdapter } = await server.ssrLoadModule("/electron/main/live-voice/gemini-adapter.ts");
  const events = [];
  const abort = new AbortController();
  const adapter = createGeminiAdapter({
    callId: "fixture-call",
    binding: { id: "gemini", adapterId: "gemini-live", providerId: "google", modelId: "fixture-model", voice: "Kore" },
    provider: {},
    auth: { kind: "api-key", apiKey: "fixture-key", baseUrl: "https://fixture.invalid" },
    signal: abort.signal, onEvent: (event) => events.push(event),
    workProfile: { version: 1, instructions: "work instructions", startupContext: "work scope" },
  });
  t.after(async () => {
    await adapter.close("user-ended");
    delete globalThis[key];
    await server.close();
  });
  return { adapter, socket, events, abort };
}

test("Gemini connects with a work target and sends audio only after valid setup", { timeout: 60_000 }, async (t) => {
  const { adapter, socket, events } = await fixture(t, (socket, message) => {
    if (message.setup) {
      const parameters = message.setup.tools[0].functionDeclarations[0].parameters;
      if ("additionalProperties" in parameters) {
        socket.emit("close", 1007, Buffer.from('Unknown name "additionalProperties"'));
      } else socket.emit("message", Buffer.from('{"setupComplete":{}}'));
    }
  });
  await adapter.connect();
  assert.deepEqual(events, [{ kind: "ready" }]);
  assert.equal(socket.sent[0].setup.tools[0].functionDeclarations[0].parameters.type, "object");
  await adapter.setInputMuted(false);
  adapter.sendInputPcm(new Uint8Array([0, 0]));
  assert.ok(socket.sent.at(-1).realtimeInput);
});

test("Gemini rejects setup immediately with protocol diagnostics on close 1007", { timeout: 60_000 }, async (t) => {
  const reason = 'Invalid JSON payload. Unknown name "additionalProperties"';
  const { adapter, events } = await fixture(t, (socket) => {
    socket.emit("close", 1007, Buffer.from(reason));
    socket.emit("error", new Error("secondary transport failure"));
  });
  const error = await Promise.race([
    adapter.connect().then(() => null, (error) => error),
    new Promise((resolve) => setImmediate(() => resolve(null))),
  ]);
  assert.equal(error?.errorCode, "LIVE_PROTOCOL_ERROR", "setup rejects on close, without waiting for its timeout");
  assert.equal(error.message, "LIVE_PROTOCOL_ERROR", "connect rejection can cross IPC without provider content");
  assert.equal(events.length, 1);
  assert.equal(events[0].code, "LIVE_PROTOCOL_ERROR");
  assert.match(events[0].reason, /1007/);
  assert.ok(events[0].reason.includes(reason));
});

test("Gemini retains transport errors and ignores terminal events after cancellation", { timeout: 60_000 }, async (t) => {
  const { adapter, socket, events, abort } = await fixture(t, (socket) => {
    socket.emit("message", Buffer.from('{"setupComplete":{}}'));
  });
  await adapter.connect();
  socket.emit("error", new Error("connection reset"));
  socket.emit("close", 1006, Buffer.alloc(0));
  assert.equal(events.filter((event) => event.kind === "error").length, 1);
  assert.equal(events.at(-1).code, "LIVE_NETWORK_ERROR");
  assert.match(events.at(-1).reason, /connection reset/);
  abort.abort();
  await adapter.close("user-ended");
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(socket.listenerCount("close"), 0);
  assert.equal(socket.listenerCount("error"), 0);
});
