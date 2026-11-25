import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { subscribeLiveSessionEvents } = await import("../electron/main/live-voice/live-session-events.ts");

const signature = (phase) => JSON.stringify({ v: 1, id: `msg_${phase}`, phase });

function nativeTurn(message) {
  let listener;
  const events = [];
  const stop = subscribeLiveSessionEvents({
    sessionId: "native-pi:s1",
    source: "pi-native",
    sidecar: { onNotification: (next) => { listener = next; return () => {}; } },
    remoteHosts: null,
    isInterrupted: () => false,
    onEvent: (event) => events.push(event),
  });
  assert.ok(stop);
  const send = (event) => listener("native.agent.event", { sessionId: "native-pi:s1", turnId: "t1", event });
  send({ type: "message_end", message });
  send({ type: "agent_end", messages: [] });
  return events;
}

// Issue #2461: a live session reports the turn's answer, never the
// Responses progress commentary stored ahead of it.
test("a live session result omits Responses commentary", () => {
  const events = nativeTurn({
    id: "a1", role: "assistant", createdAt: "2026-11-20T00:00:00Z",
    content: "正在核对。答案是 B。",
    providerReplay: { version: 1, blocks: [
      { type: "text", length: 5, signature: signature("commentary") },
      { type: "text", length: 6, signature: signature("final_answer") },
    ] },
  });
  assert.equal(events.find((event) => event.kind === "terminal")?.resultText, "答案是 B。");
});

test("a live session result keeps unmarked text as is", () => {
  const events = nativeTurn({
    id: "a1", role: "assistant", createdAt: "2026-11-20T00:00:00Z", content: "正在核对。答案是 B。",
  });
  assert.equal(events.find((event) => event.kind === "terminal")?.resultText, "正在核对。答案是 B。");
});
