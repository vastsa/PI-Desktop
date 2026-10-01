import assert from "node:assert/strict";
import test from "node:test";
import { createAdapterWorkHarness } from "./helpers/live-adapter-work.mjs";
import { settleUntil, WORK_INSTRUCTION, WORK_RESULT } from "./helpers/live-work-production.mjs";

const profiles = ["gemini-live", "realtime-ga", "realtime-compat-v1"];

for (const profile of profiles) {
  test(`${profile} concrete adapter reaches production Main admission and exact terminal feedback`, async (t) => {
    const h = await createAdapterWorkHarness(t, profile);
    h.socket.candidate("request-1", WORK_INSTRUCTION);
    await settleUntil(() => h.prompts.length === 1, "the registered agentPrompt handler receives the adapter request");
    assert.equal(h.prompts[0].content, WORK_INSTRUCTION);
    assert.equal(h.persistedMessages[0].id, h.prompts[0].messageId);
    assert.deepEqual(h.persistedMessages[0].voiceOrigin, h.prompts[0].voiceOrigin);
    assert.equal(h.prompts[0].voiceOrigin.callId, h.prepared.callId);
    assert.equal(h.socket.receipts().length, 1);
    const receipt = h.socket.receipts()[0];
    const payload = profile === "gemini-live" ? receipt.toolResponse.functionResponses[0].response : JSON.parse(receipt.item.output);
    assert.equal(payload.status, "received");
    assert.equal(payload.execution, "not_started");
    assert.equal(payload.operationId, h.prompts[0].voiceOrigin.operationId);
    h.socket.candidate("request-1", WORK_INSTRUCTION);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.prompts.length, 1, "a repeated provider event cannot create another task");
    assert.equal(h.socket.receipts().length, 1);

    const audioBytes = Buffer.from([1, 0, 2, 0]).toString("base64");
    if (profile === "gemini-live") {
      h.socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audioBytes } }] } } });
    } else {
      h.socket.receive({ type: "response.created", response: { id: "response-1" } });
      h.socket.receive({ type: profile === "realtime-ga" ? "response.output_audio.delta" : "response.audio.delta", response_id: "response-1", item_id: "item-1", content_index: 0, delta: audioBytes });
    }
    assert.equal(h.audio.length, 1, "actual adapter parsing reaches the PCM output boundary");
    h.endTurn();
    await settleUntil(() => h.results.size === 1, "the production result reader resolves exact-turn history");
    assert.equal([...h.results.values()][0].resultSummary, WORK_RESULT);
    assert.ok(h.historyReadsAfterTerminal >= 2);
    h.advanceFeedback();
    assert.equal(h.socket.feedback().length, 0, "work feedback cannot interrupt active provider generation");
    if (profile === "gemini-live") h.socket.receive({ serverContent: { turnComplete: true } });
    else h.socket.receive({ type: "response.done", response: { id: "response-1" } });
    h.advanceFeedback();
    assert.equal(h.socket.feedback().length, 0, "generation completion is not evidence that PCM output has drained");
    h.drainPlayback();
    h.advanceFeedback();
    await settleUntil(() => h.socket.feedback().length === 1, "feedback is delivered after generation and local playback become idle");
    assert.match(JSON.stringify(h.socket.feedback()[0]), /The login flow correctly rejects expired credentials/);
    assert.doesNotMatch(JSON.stringify(h.views), /synthetic-live-secret|Authorization|fixture-key/);
    if (profile !== "gemini-live") {
      assert.equal(h.connectionRequests[0].headers["OpenAI-Beta"], profile === "realtime-compat-v1" ? "realtime=v1" : undefined);
    }
  });

  test(`${profile} rejects undeclared work arguments before production admission`, async (t) => {
    const h = await createAdapterWorkHarness(t, profile);
    h.socket.candidate("malicious-request", WORK_INSTRUCTION, { sessionId: "another-session", permissionMode: "auto" });
    await settleUntil(() => h.socket.receipts().length === 1, "the concrete adapter rejects extra fields");
    assert.match(JSON.stringify(h.socket.receipts()[0]), /LIVE_WORK_INVALID_REQUEST/);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.persistedMessages.length, 0);
    assert.equal(h.updates.length, 0, "malformed work must not reach the coordinator");
  });

  test(`${profile} waits for the actual receipt send result before dispatching work`, async (t) => {
    const h = await createAdapterWorkHarness(t, profile);
    h.socket.holdReceipts = true;
    h.socket.candidate("failed-receipt", WORK_INSTRUCTION);
    await settleUntil(() => h.socket.receiptCallbacks.length === 1, "receipt reached the socket boundary");
    for (let tick = 0; tick < 5; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.prompts.length, 0, "queued socket.send is not yet a successful local send");
    h.socket.settleReceipt(new Error("synthetic socket write failure"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.prompts.length, 0, "a failed receipt must never admit work");
    assert.equal(h.persistedMessages.length, 0);
  });

  test(`${profile} drops late socket messages and removes adapter listeners after close`, async (t) => {
    const h = await createAdapterWorkHarness(t, profile);
    await h.service.end(h.owner, { callId: h.prepared.callId, reason: "user-ended" });
    assert.equal(h.socket.listenerCount("message"), 0);
    assert.equal(h.socket.listenerCount("close"), 0);
    assert.equal(h.socket.listenerCount("error"), 0);
    const sends = h.socket.sent.length;
    h.socket.candidate("late-request", WORK_INSTRUCTION);
    assert.equal(h.socket.sent.length, sends);
    assert.equal(h.prompts.length, 0);
  });
}

for (const profile of profiles.slice(1)) {
  test(`${profile} old completion and audio cannot clear the active response after interruption`, async (t) => {
    const h = await createAdapterWorkHarness(t, profile);
    const deltaType = profile === "realtime-ga" ? "response.output_audio.delta" : "response.audio.delta";
    const audio = (responseId) => ({ type: deltaType, response_id: responseId, item_id: `${responseId}-item`, content_index: 0, delta: "AQACAA==" });
    h.socket.receive({ type: "response.created", response: { id: "old-response" } });
    h.socket.receive(audio("old-response"));
    h.socket.receive({ type: "input_audio_buffer.speech_started" });
    h.socket.receive({ type: "response.created", response: { id: "new-response" } });
    h.socket.receive(audio("new-response"));
    const count = h.audio.length;
    h.socket.receive(audio("old-response"));
    h.socket.receive({ type: "response.done", response: { id: "old-response" } });
    assert.equal(h.audio.length, count, "old-epoch audio is discarded by the concrete adapter");
    assert.equal(h.views.at(-1).assistantSpeaking, true, "old completion cannot clear the new response activity");
  });
}
