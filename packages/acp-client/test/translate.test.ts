/**
 * ACP → desktop event translation.
 *
 * The contract being tested is the desktop's, not ACP's: the transcript must
 * never see an ACP object, a streamed message must not become N messages, and
 * nothing may be left stuck in "streaming" when a turn ends.
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import { AcpEventTranslator } from "../src/translate.ts"
import type { AcpSessionUpdate, AcpSessionUpdateNotification } from "../src/types.ts"
import type { AgentEvent } from "@pi-desktop/shared"

const SESSION = "sess_host_1"
const TURN = "turn_1"

function makeTranslator(overrides = {}) {
  let t = 0
  const translator = new AcpEventTranslator({
    sessionId: SESSION,
    turnId: TURN,
    now: () => ++t * 100,
    ...overrides,
  })
  const feed = (update: AcpSessionUpdate) =>
    translator.translate({ sessionId: "acp_sess_1", update } as AcpSessionUpdateNotification)
  return { translator, feed }
}

const types = (events: { event: AgentEvent }[]) => events.map((e) => e.event.type)
const chunk = (text: string, messageId?: string): AcpSessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  ...(messageId ? { messageId } : {}),
  content: { type: "text", text },
})

// ---------------------------------------------------------------------------
// streaming text
// ---------------------------------------------------------------------------

test("the first chunk opens a message, later chunks only append", () => {
  const { feed } = makeTranslator()

  const first = feed(chunk("Merh", "msg_1"))
  assert.deepEqual(types(first), ["message_start", "message_update"])
  // `message_start` opens empty and the text arrives as a delta, so the
  // renderer applies it exactly once instead of snapshot-plus-delta.
  assert.equal((first[0].event as { message: { content: string } }).message.content, "")
  assert.equal((first[1].event as { deltaText?: string }).deltaText, "Merh")

  const second = feed(chunk("aba", "msg_1"))
  assert.deepEqual(types(second), ["message_update"])
  const upd = second[0].event as { stream?: string; deltaText?: string; message: { content: string } }
  assert.equal(upd.stream, "delta")
  assert.equal(upd.deltaText, "aba")
  // The snapshot still carries the full text so a late subscriber is correct.
  assert.equal(upd.message.content, "Merhaba")
})

test("one message with many chunks yields one start and one end", () => {
  const { feed, translator } = makeTranslator()
  for (const piece of ["a", "b", "c", "d"]) feed(chunk(piece, "msg_1"))

  const closed = translator.finish({ stopReason: "end_turn" })
  const starts = closed.filter((e) => e.event.type === "message_start").length
  const ends = closed.filter((e) => e.event.type === "message_end")
  assert.equal(starts, 0)
  assert.equal(ends.length, 1, "exactly one message must close")
  const m = (ends[0].event as { message: { content: string; status?: string } }).message
  assert.equal(m.content, "abcd")
  assert.equal(m.status, "complete")
})

test("two different messageIds become two messages", () => {
  const { feed, translator } = makeTranslator()
  feed(chunk("one", "msg_1"))
  feed(chunk("two", "msg_2"))

  const closed = translator.finish({ stopReason: "end_turn" })
  const ends = closed.filter((e) => e.event.type === "message_end")
  assert.equal(ends.length, 2)
  const contents = ends.map((e) => (e.event as { message: { content: string } }).message.content)
  assert.deepEqual(contents, ["one", "two"])
})

test("thoughts accumulate on the same message, separately from the answer", () => {
  const { feed, translator } = makeTranslator()
  feed({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } })
  feed(chunk("answer"))

  const closed = translator.finish({ stopReason: "end_turn" })
  const m = (closed.find((e) => e.event.type === "message_end")!.event as { message: { content: string; thinking?: string } }).message
  assert.equal(m.content, "answer")
  assert.equal(m.thinking, "hmm")
})

test("a message id is synthesised when the agent omits one", () => {
  const { feed, translator } = makeTranslator()
  feed(chunk("no id here"))
  const closed = translator.finish({ stopReason: "end_turn" })
  const m = (closed.find((e) => e.event.type === "message_end")!.event as { message: { id: string } }).message
  assert.ok(m.id.length > 0, "a transcript row still needs a stable id")
})

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

test("a tool call opens once, updates, then closes", () => {
  const { feed } = makeTranslator()
  assert.deepEqual(
    types(feed({ sessionUpdate: "tool_call", toolCallId: "t1", title: "read_file", rawInput: { path: "a" } })),
    ["tool_start"],
  )
  assert.deepEqual(
    types(feed({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" })),
    ["tool_update"],
  )
  assert.deepEqual(
    types(feed({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "ok" })),
    ["tool_end"],
  )
})

test("a repeated tool_call update does not open the tool twice", () => {
  const { feed } = makeTranslator()
  feed({ sessionUpdate: "tool_call", toolCallId: "t1", title: "grep" })
  const again = feed({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" })
  // Re-announcing would render a second tool row in the transcript.
  assert.equal(again.filter((e) => e.event.type === "tool_start").length, 0)
})

test("a failed tool ends with isError", () => {
  const { feed } = makeTranslator()
  feed({ sessionUpdate: "tool_call", toolCallId: "t1", title: "boom" })
  const end = feed({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" })
  assert.equal((end[0].event as { isError?: boolean }).isError, true)
})

test("a tool left running when the turn ends is closed as failed", () => {
  const { feed, translator } = makeTranslator()
  feed({ sessionUpdate: "tool_call", toolCallId: "t1", title: "hangs" })
  const closed = translator.finish({ stopReason: "end_turn" })
  const ends = closed.filter((e) => e.event.type === "tool_end")
  assert.equal(ends.length, 1)
  assert.equal((ends[0].event as { isError?: boolean }).isError, true)
})

// ---------------------------------------------------------------------------
// turn close-out
// ---------------------------------------------------------------------------

test("a normal turn ends with turn_end then agent_end", () => {
  const { feed, translator } = makeTranslator()
  feed(chunk("hi", "msg_1"))
  const closed = translator.finish({ stopReason: "end_turn" })
  const tail = types(closed).slice(-2)
  assert.deepEqual(tail, ["turn_end", "agent_end"])
})

test("usage lands on the last assistant message", () => {
  const { feed, translator } = makeTranslator()
  feed(chunk("hi", "msg_1"))
  const closed = translator.finish({
    stopReason: "end_turn",
    usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128, thoughtTokens: 3 },
  })
  const m = (closed.find((e) => e.event.type === "message_end")!.event as { message: { usage?: Record<string, number> } }).message
  assert.equal(m.usage?.inputTokens, 120)
  assert.equal(m.usage?.totalTokens, 128)
  assert.equal(m.usage?.reasoningTokens, 3)
})

test("a refusal is surfaced as an error, not a silent end", () => {
  const { translator } = makeTranslator()
  const closed = translator.finish({ stopReason: "refusal" })
  const err = closed.find((e) => e.event.type === "error")
  assert.ok(err, "a refusal must be visible to the user")
  assert.equal((err!.event as { error: { code: string } }).error.code, "refusal")
})

test("a transport failure is reported with the agent's own code", () => {
  const { translator } = makeTranslator()
  const closed = translator.finish(undefined, { code: "-32000", message: "agent exited" })
  const err = closed.find((e) => e.event.type === "error")
  assert.equal((err!.event as { error: { code: string } }).error.code, "-32000")
})

// ---------------------------------------------------------------------------
// plans, envelopes, unknowns
// ---------------------------------------------------------------------------

test("a plan renders as assistant content, not a fabricated proposal", () => {
  const { feed } = makeTranslator()
  const out = feed({
    sessionUpdate: "plan",
    entries: [
      { content: "read the file", status: "completed" },
      { content: "write the fix", status: "in_progress" },
    ],
  })
  assert.deepEqual(types(out), ["message_start", "message_update"])
  const text = (out[1].event as { deltaText?: string }).deltaText ?? ""
  assert.match(text, /\[x\] read the file/)
  assert.match(text, /\[~\] write the fix/)
  // planning_state would invent a host-owned proposal the approval flow acts on.
  assert.equal(out.filter((e) => e.event.type === "planning_state").length, 0)
})

test("every envelope carries the host's own session and turn id", () => {
  const { feed, translator } = makeTranslator()
  const all = [...feed(chunk("x", "msg_1")), ...translator.finish({ stopReason: "end_turn" })]
  for (const e of all) {
    assert.equal(e.sessionId, SESSION, "the ACP session id must never leak")
    assert.equal(e.turnId, TURN)
    assert.equal(typeof e.ts, "number")
  }
})

test("an unknown update from a future agent is ignored, not fatal", () => {
  const { feed } = makeTranslator()
  const out = feed({ sessionUpdate: "some_future_block", payload: 1 } as unknown as AcpSessionUpdate)
  assert.deepEqual(out, [])
})

test("observational updates with no desktop equivalent are dropped quietly", () => {
  const { feed } = makeTranslator()
  for (const u of [
    { sessionUpdate: "usage_update", used: 10, size: 100 },
    { sessionUpdate: "available_commands_update", availableCommands: [] },
    { sessionUpdate: "current_mode_update", currentModeId: "build" },
  ] as AcpSessionUpdate[]) {
    assert.deepEqual(feed(u), [], `${u.sessionUpdate} should not fabricate an event`)
  }
})
