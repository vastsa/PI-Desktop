import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Local TLS peer only: the app still owns its real socket, media and IPC path. */
export async function startLiveVoiceFixture(root) {
  const { WebSocketServer, WebSocket } = createRequire(join(root, "apps/desktop/package.json"))("ws");
  const certificates = join(root, "scripts/e2e/fixtures/certificates");
  const certificate = join(certificates, "localhost-cert.pem");
  const server = createServer({
    key: await readFile(join(certificates, "localhost-key.pem")),
    cert: await readFile(certificate),
  }, (_request, response) => { response.writeHead(404); response.end(); });
  const sockets = new Set();
  const timers = new Set();
  const errors = [];
  const stats = { connections: 0, configured: 0, inputFrames: 0, inputBytes: 0, outputFrames: 0, closed: 0, modelRequests: 0 };
  const websocket = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });
  let holdNext = false;
  let profile = "realtime-ga";
  let responseSequence = 0;
  const later = (fn) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, 30);
    timers.add(timer);
  };
  const send = (socket, message) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  websocket.on("connection", (socket, request) => {
    sockets.add(socket);
    stats.connections++;
    const held = holdNext;
    holdNext = false;
    try {
      assert.equal(new URL(request.url, "https://localhost").pathname, "/v1/realtime");
      assert.equal(request.headers.authorization, "Bearer live-voice-e2e-key");
    } catch { errors.push("unexpected Realtime connection metadata"); socket.close(); return; }
    socket.once("close", () => { sockets.delete(socket); stats.closed++; });
    socket.on("error", () => errors.push("local Realtime fixture socket failed"));
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(String(data));
        if (message.type === "session.update") {
          assert.equal(message.session.model, "live-voice-fixture");
          const tools = message.session.tools ?? [];
          assert.equal(tools.length, 1, "a Composer-bound work call exposes exactly one declared tool");
          assert.deepEqual(tools.map((tool) => ({ type: tool.type, name: tool.name })), [
            { type: "function", name: "delegate_to_work_session" },
          ]);
          assert.deepEqual(Object.keys(tools[0]?.parameters?.properties ?? {}), ["instruction"]);
          assert.deepEqual(tools[0]?.parameters?.required, ["instruction"]);
          assert.equal(tools[0]?.parameters?.additionalProperties, false);
          profile = message.session.type === "realtime" ? "realtime-ga" : "realtime-compat-v1";
          if (!held) {
            stats.configured++;
            send(socket, { type: "session.updated", session: message.session });
          }
        } else if (message.type === "input_audio_buffer.append") {
          const bytes = Buffer.from(message.audio, "base64");
          assert.ok(bytes.length > 0 && bytes.length <= 4800 && bytes.length % 2 === 0);
          stats.inputFrames++;
          stats.inputBytes += bytes.length;
        } else if (!["response.cancel", "conversation.item.truncate"].includes(message.type)) {
          errors.push("unexpected provider request during voice-only acceptance");
        }
      } catch { errors.push("invalid local Realtime fixture message"); }
    });
    later(() => send(socket, { type: "session.created", session: { id: "isolated-fixture-session" } }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    certificate,
    baseUrl: `https://localhost:${server.address().port}/v1`,
    stats,
    errors,
    active: () => sockets.size,
    holdNextSession: () => { holdNext = true; },
    reply() {
      const responseId = `fixture-response-${++responseSequence}`;
      for (const socket of sockets) {
        send(socket, { type: "response.created", response: { id: responseId } });
        send(socket, { type: profile === "realtime-ga" ? "response.output_audio.delta" : "response.audio.delta",
          response_id: responseId, item_id: responseId, content_index: 0, delta: Buffer.alloc(2400).toString("base64") });
        stats.outputFrames++;
        send(socket, { type: profile === "realtime-ga" ? "response.output_audio_transcript.done" : "response.audio_transcript.done",
          response_id: responseId, item_id: responseId, transcript: "Local voice fixture reply." });
        send(socket, { type: "response.done", response: { id: responseId } });
      }
    },
    disconnect() { for (const socket of sockets) socket.terminate(); },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets) socket.terminate();
      await new Promise((resolve) => websocket.close(resolve));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
