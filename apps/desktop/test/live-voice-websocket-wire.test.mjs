import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

async function fixture(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { sendJsonConfirmed, waitForSocketReady } = await server.ssrLoadModule("/electron/main/live-voice/websocket-wire.ts");
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.bufferedAmount = 0;
  socket.sent = [];
  socket.send = (body, callback) => { socket.sent.push(body); socket.callback = callback; };
  socket.terminate = () => { socket.readyState = 3; socket.emit("close"); };
  return { sendJsonConfirmed, waitForSocketReady, socket, abort: new AbortController() };
}

test("socket readiness rejects an already-cancelled open socket", async (t) => {
  const { waitForSocketReady, socket, abort } = await fixture(t);
  abort.abort();
  await assert.rejects(waitForSocketReady(socket, abort.signal), { errorCode: "LIVE_STALE_CALL" });
});

test("confirmed Live JSON waits for the local write callback and clears observers", async (t) => {
  const { sendJsonConfirmed, socket, abort } = await fixture(t);
  let complete = false;
  const pending = sendJsonConfirmed(socket, { receipt: "received" }, abort.signal).then(() => { complete = true; });
  await Promise.resolve();
  assert.equal(complete, false);
  socket.callback();
  await pending;
  assert.equal(complete, true);
  assert.equal(socket.listenerCount("close"), 0);
  assert.equal(socket.listenerCount("error"), 0);
});

test("confirmed Live JSON rejects an asynchronous local write failure without its error detail", async (t) => {
  const { sendJsonConfirmed, socket, abort } = await fixture(t);
  const pending = sendJsonConfirmed(socket, { receipt: "received" }, abort.signal);
  const rejection = assert.rejects(pending, (error) => error.errorCode === "LIVE_WORK_FEEDBACK_UNDELIVERED" && !error.message.includes("secret-sentinel"));
  socket.callback(new Error("secret-sentinel"));
  await rejection;
  assert.equal(socket.readyState, 3);
  assert.equal(socket.listenerCount("close"), 0);
  assert.equal(socket.listenerCount("error"), 0);
});

for (const reason of ["abort", "close", "timeout"]) {
  test(`confirmed Live JSON ${reason} is bounded and cannot be revived by a late callback`, async (t) => {
    const { sendJsonConfirmed, socket, abort } = await fixture(t);
    if (reason === "timeout") t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = sendJsonConfirmed(socket, { receipt: "received" }, abort.signal);
    const rejection = assert.rejects(pending, { errorCode: "LIVE_WORK_FEEDBACK_UNDELIVERED" });
    if (reason === "abort") abort.abort();
    else if (reason === "close") socket.terminate();
    else t.mock.timers.tick(1_000);
    await rejection;
    socket.callback();
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.listenerCount("close"), 0);
    assert.equal(socket.listenerCount("error"), 0);
  });
}

test("confirmed Live JSON preserves transport backpressure and cancellation guards", async (t) => {
  const { sendJsonConfirmed, socket, abort } = await fixture(t);
  socket.bufferedAmount = 128 * 1024;
  await assert.rejects(sendJsonConfirmed(socket, { receipt: "received" }, abort.signal), { errorCode: "LIVE_AUDIO_BACKPRESSURE" });
  socket.bufferedAmount = 0;
  abort.abort();
  await assert.rejects(sendJsonConfirmed(socket, { receipt: "received" }, abort.signal), { errorCode: "LIVE_WORK_FEEDBACK_UNDELIVERED" });
  assert.equal(socket.sent.length, 0);
});

test("Gemini Live does not send setup when cancellation follows WebSocket open", async (t) => {
  const key = `live-gemini-open-cancel-${Date.now()}-${Math.random()}`;
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.bufferedAmount = 0;
  socket.sent = [];
  socket.send = (body, callback) => {
    socket.sent.push(JSON.parse(body));
    queueMicrotask(() => callback?.());
  };
  socket.close = () => {
    socket.readyState = 3;
    socket.emit("close", 1000);
  };
  socket.terminate = () => {
    socket.readyState = 3;
    socket.emit("close", 1006);
  };
  globalThis[key] = async () => socket;

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: "live-gemini-open-cancel-fixture",
      enforce: "pre",
      resolveId(source) {
        if (source === "./websocket-transport" || /\/live-voice\/websocket-transport(?:\.ts)?$/.test(source)) return "\0live-gemini-socket-fixture";
      },
      load(id) {
        if (id === "\0live-gemini-socket-fixture") return `export const openLiveWebSocket = (input) => globalThis[${JSON.stringify(key)}](input);`;
      },
    }],
  });
  t.after(async () => {
    delete globalThis[key];
    await server.close();
  });
  const { createGeminiAdapter } = await server.ssrLoadModule("/electron/main/live-voice/gemini-adapter.ts");
  const abort = new AbortController();
  const adapter = createGeminiAdapter({
    callId: "call-cancelled-after-open",
    binding: { id: "gemini", adapterId: "gemini-live", providerId: "provider", modelId: "fixture-model", voice: "Kore" },
    provider: {},
    auth: { kind: "api-key", apiKey: "fixture-key", baseUrl: "https://fixture.invalid" },
    signal: abort.signal,
    onEvent() {},
    workProfile: { version: 1, instructions: "fixture instructions", startupContext: "fixture context" },
  });

  const connecting = adapter.connect();
  const rejected = assert.rejects(connecting, { errorCode: "LIVE_STALE_CALL" });
  abort.abort(new Error("call cancelled"));
  await rejected;

  assert.equal(socket.sent.some((message) => message.setup), false, "cancelled startup cannot disclose the work profile in setup");
  await adapter.close("user-cancelled-start");
});
