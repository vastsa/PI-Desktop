import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { applyMessageUpdate, cumulativeDelta, hostedSearchFromMessage, toWireMessageUpdate } = await import("@pi-desktop/shared");
const { assistantContent } = await import("../../../packages/agent-runtime/src/agent-messages.ts");
const { captureAssistantProviderReplay } = await import("../../../packages/agent-runtime/src/assistant-provider-replay.ts");
const { buildTranscriptEntries } = await import("../src/lib/assistant-turns.ts");
const { getAssistantTurnContent, getAssistantTurnSummary } = await import("../src/lib/transcript-summary.ts");
const { segmentTurnProcess } = await import("../src/lib/turn-process.ts");

const base = { id: "one", role: "assistant", content: "", createdAt: "2026-01-01T00:00:00Z" };
const think = (thinking) => ({ type: "thinking", thinking });
const text = (text, phase) => ({ type: "text", text, textSignature: JSON.stringify({ v: 1, id: `msg_${text}`, phase }) });
const search = (id) => ({ type: "hostedSearch", phase: "web_search_call", blockId: id, status: "completed" });
const blocks = [think("T1"), text("C1🔍", "commentary"), search("S1"), think("T2"), text("C2", "commentary"), search("S2"), text("Answer", "final_answer")];
const steps = ["T1", "C1🔍", "S1", "T2", "C2", "S2"];

function snapshot(content) {
  const parts = assistantContent(content, "openai-responses");
  return { ...base, content: parts.text, thinking: parts.thinking, commentaryRanges: parts.commentaryRanges,
    responseLayout: parts.responseLayout, hostedSearch: hostedSearchFromMessage({ content }), status: "streaming" };
}

function checkRow(row, expected, answer) {
  const [turn] = buildTranscriptEntries([row]).entries;
  const summary = getAssistantTurnSummary(turn);
  for (const mode of ["flat", "command-first", "fully-folded"]) {
    const items = segmentTurnProcess(summary.process, mode).flatMap(s => s.parts).flatMap(p => p.kind === "message"
      ? [p.message.content] : p.items.map(i => i.kind === "thinking" ? i.message.thinking : i.round.id));
    assert.deepEqual(items, expected, mode);
  }
  assert.deepEqual(summary.responses.map(p => p.message.content), answer ? [answer] : []);
  assert.equal(getAssistantTurnContent(turn), answer);
  return summary;
}

test("interleaved Responses items keep their positions at each wire update and after a reload", () => {
  let live = { ...base, status: "streaming" };
  for (let i = 0; i < blocks.length; ++i) {
    const next = snapshot(blocks.slice(0, i + 1));
    const { delta: dt } = cumulativeDelta(live.content, next.content);
    const { delta: dr } = cumulativeDelta(live.thinking ?? "", next.thinking);
    live = applyMessageUpdate(live, toWireMessageUpdate({ type: "message_update", message: next,
      ...(dt ? { deltaText: dt } : {}), ...(dr ? { deltaThinking: dr } : {}) }));
    checkRow(live, steps.slice(0, i + 1), i === blocks.length - 1 ? "Answer" : "");
  }
  const done = { ...live, status: "complete", providerReplay: captureAssistantProviderReplay(blocks), usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6 } };
  assert.equal(checkRow(done, steps, "Answer").usage.totalTokens, 6);
  const { commentaryRanges, ...stored } = done;
  checkRow(JSON.parse(JSON.stringify(stored)), steps, "Answer");
  assert.equal(done.content, "C1🔍C2Answer");
});

test("reasoning on either side of a Responses search does not require a commentary phase", () => {
  checkRow(snapshot([think("before"), search("search"), think("after"), { type: "text", text: "I will check." }]),
    ["before", "search", "after"], "I will check.");
});

test("missing or unusable order retains legacy phase separation without inventing positions", () => {
  const row = { ...snapshot(blocks), commentaryRanges: undefined, providerReplay: captureAssistantProviderReplay(blocks) };
  for (const responseLayout of [undefined, [{ type: "thinking", length: 999 }], [{ type: "search", id: "unknown" }]]) {
    checkRow({ ...row, responseLayout }, ["T1T2", "S1", "S2", "C1🔍", "C2"], "Answer");
  }
});

test("a clipped thinking preview still separates complete text when replay signatures are unavailable", () => {
  const row = { ...snapshot(blocks), thinking: "…", providerReplay: undefined, commentaryRanges: undefined };
  checkRow(row, ["…", "S1", "S2", "C1🔍", "C2"], "Answer");
});

test("a search round updated twice renders once at its first position", () => {
  const content = [text("A", "commentary"), search("same"), think("B"), search("same"), text("C", "final_answer")];
  checkRow(snapshot(content), ["A", "same", "B"], "C");
  assert.equal(assistantContent(content, "anthropic-messages").responseLayout, undefined);
});
