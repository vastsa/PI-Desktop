import assert from "node:assert/strict";
import test from "node:test";
import { steerActiveTurn, SteeringTranscript } from "../electron/main/agent-steering.ts";

function fixture() {
  const calls = [];
  let target = "turn-1";
  const options = {
    dataDir: "/unused", activeTurn: () => "turn-1", isFinalizing: () => false,
    host: { call: async (method) => { calls.push(method); return { session: { messages: [] } }; } },
    sidecar: { call: async (method, params) => {
      calls.push([method, params]);
      if (method === "agent.steeringContext") return { supportsVision: true };
      if (params.expectedTurnId !== target) throw Object.assign(new Error("stale target"), { errorCode: "TURN_NOT_FOUND" });
      return { accepted: true, turnId: target };
    } },
  };
  return { options, calls, changeTarget: () => { target = "turn-2"; } };
}
const request = { sessionId: "session-1", expectedTurnId: "turn-1", content: "redirect" };

test("main routes steering to an existing turn without launching or writing a new turn", async () => {
  const { options, calls } = fixture();
  assert.deepEqual(await steerActiveTurn(request, options), { accepted: true, turnId: "turn-1" });
  assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ["agent.steeringContext", "session.get", "agent.steer"]);
  assert.equal(calls[2][1].expectedTurnId, "turn-1");
  assert.equal(calls[2][1].message.role, "user");
  assert.equal(calls[2][1].provider, undefined);
});

test("stale targets fail before preparation and are checked again by the runtime after IO", async () => {
  const first = fixture();
  await assert.rejects(steerActiveTurn({ ...request, expectedTurnId: "old" }, first.options), { errorCode: "TURN_NOT_FOUND" });
  assert.deepEqual(first.calls, []);
  const race = fixture();
  race.options.host.call = async () => { race.changeTarget(); return { session: { messages: [] } }; };
  await assert.rejects(steerActiveTurn(request, race.options), { errorCode: "TURN_NOT_FOUND" });
});

test("steering persistence reserves the preceding reply and retains the explicit turn", () => {
  const writes = [];
  const transcript = new SteeringTranscript({ enqueue: async (row) => { writes.push(row); } }, () => null, () => {});
  const assistant = { id: "reply", role: "assistant", content: "partial", status: "streaming" };
  const user = { id: "input", role: "user", content: "redirect", status: "complete" };
  transcript.persistInput({ sessionId: "s1", turnId: "original", ts: 1, event: { type: "message_end", message: user, precedingAssistant: assistant } }, "new-turn");
  assert.deepEqual(writes.map((row) => [row.message.id, row.turnId]), [["reply", "original"], ["input", "original"]]);
  assert.equal(transcript.settleReply("reply"), true);
  assert.equal(transcript.settleReply("reply"), false);
  transcript.clear();
});
