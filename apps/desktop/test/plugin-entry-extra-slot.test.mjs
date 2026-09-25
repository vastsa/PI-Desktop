import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import {
  probed,
  propsProbe,
  slotMounts,
  slotSsr,
  withoutProbeProps,
} from "./helpers/slot-ssr.mjs";

/*
 * The `entryExtra` outlet (`docs/plugin-plan/ui/entry-extra/`) rendered with
 * the production modules: one block per registration under a finished reply,
 * in registration order, each in its plugin's mount inside the host's clamped
 * viewport, fed `{ message, messageId, sessionId }`. Server rendering is the
 * first frame of a mount; the expand toggle, which needs a measurement, and
 * a throwing block collapsing alone are covered by the Electron E2E.
 */

const REPLY = {
  id: "a2",
  role: "assistant",
  content: "It says x.",
  createdAt: "2026-09-24T00:00:03.000Z",
};

/** A user prompt answered in two parts around a tool call. */
function conversation(overrides = {}) {
  return [
    { id: "u1", role: "user", content: "hello", status: "complete", createdAt: "2026-09-24T00:00:00.000Z" },
    { id: "a1", role: "assistant", content: "Let me look.", status: "complete", createdAt: "2026-09-24T00:00:01.000Z" },
    {
      id: "t1",
      role: "tool",
      content: "",
      status: "complete",
      createdAt: "2026-09-24T00:00:02.000Z",
      toolName: "read",
      toolCallId: "call-1",
      toolArgs: { path: "a.txt" },
      toolStatus: "success",
      toolResult: "x",
    },
    { ...REPLY, status: "complete", ...overrides },
  ];
}

async function outlet(t) {
  const ssr = await slotSsr(t);
  const { EntryExtraStack } = await ssr.load("/src/features/chat/transcript/EntryExtraStack.tsx");
  const { AssistantTurn } = await ssr.load("/src/features/chat/transcript/AssistantTurn.tsx");
  const { assistantTurnContent, buildTranscriptEntries } = await ssr.load("/src/lib/assistant-turns.ts");
  const turnOf = (messages) =>
    buildTranscriptEntries(messages).entries.find((entry) => entry.kind === "assistant-turn");
  return {
    ...ssr,
    assistantTurnContent,
    turnOf,
    stack: (message = REPLY, options) => ssr.render(createElement(EntryExtraStack, { message }), options),
    turn: (entry, props = {}) =>
      ssr.render(createElement(AssistantTurn, { entry, isActive: false, ...props })),
  };
}

test("a reply with no entryExtra registration has no slot region", async (t) => {
  const ssr = await outlet(t);
  assert.equal(ssr.stack(), "");
  ssr.register("demo.a", { slot: "assistantAction", component: propsProbe("action") });
  assert.equal(ssr.stack(), "", "another slot's registration is not a block");
  assert.doesNotMatch(ssr.turn(ssr.turnOf(conversation())), /pi-entry-extra/);
});

test("each registration is one clamped block around its plugin's mount", async (t) => {
  const ssr = await outlet(t);
  ssr.register("demo.a", { slot: "entryExtra", component: propsProbe("extra") });
  const html = ssr.stack(REPLY, { sessionId: "session-7" });
  assert.equal(
    withoutProbeProps(html),
    [
      '<div class="pi-entry-extra-stack">',
      '<div class="pi-entry-extra-block">',
      '<div class="pi-entry-extra-viewport" style="max-height:320px">',
      '<div><div class="pi-plugin-slot" data-pi-plugin="demo.a" data-pi-slot="entryExtra">',
      '<output data-probe="extra"></output>',
      "</div></div></div></div></div>",
    ].join(""),
    "the first frame is collapsed at 320px, with no toggle until a measurement asks for one",
  );
  assert.deepEqual(probed(html, "extra"), [
    { message: REPLY, messageId: "a2", sessionId: "session-7" },
  ]);
});

test("blocks stack in registration order across plugins, and each leaves on its own", async (t) => {
  const ssr = await outlet(t);
  const first = ssr.register("demo.a", { slot: "entryExtra", component: propsProbe("a") });
  ssr.register("demo.b", { slot: "entryExtra", component: propsProbe("b") });
  ssr.register("demo.a", { slot: "entryExtra", component: propsProbe("a2") });
  assert.deepEqual(slotMounts(ssr.stack()), [
    ["demo.a", "entryExtra"],
    ["demo.b", "entryExtra"],
    ["demo.a", "entryExtra"],
  ]);
  assert.equal((ssr.stack().match(/pi-entry-extra-block/g) ?? []).length, 3);

  first();
  assert.deepEqual(slotMounts(ssr.stack()), [
    ["demo.b", "entryExtra"],
    ["demo.a", "entryExtra"],
  ]);
  ssr.clear();
  assert.equal(ssr.stack(), "");
});

test("a finished turn shows the stack under its action bar, fed the reply the host keys act on", async (t) => {
  const ssr = await outlet(t);
  ssr.register("demo.a", { slot: "entryExtra", component: propsProbe("extra") });
  const entry = ssr.turnOf(conversation());
  const html = ssr.turn(entry);

  const actionsAt = html.indexOf('<div class="message-actions">');
  const stackAt = html.indexOf('<div class="pi-entry-extra-stack">');
  assert.ok(actionsAt >= 0, "the host action bar stays");
  assert.ok(stackAt > actionsAt, "the stack sits under the action bar");
  assert.equal(html.indexOf('<div class="pi-entry-extra-stack">', stackAt + 1), -1, "one stack per turn");

  // The id is the answer message Regenerate and Branch act on; the content
  // is the whole turn's text, as Copy copies it.
  const content = ssr.assistantTurnContent(entry);
  assert.equal(content, "Let me look.\n\nIt says x.");
  assert.deepEqual(probed(html, "extra"), [
    {
      message: { id: "a2", role: "assistant", content, createdAt: REPLY.createdAt },
      messageId: "a2",
      sessionId: "session-1",
    },
  ]);
});

test("a live, failed or text-less turn has no slot region", async (t) => {
  const ssr = await outlet(t);
  ssr.register("demo.a", { slot: "entryExtra", component: propsProbe("extra") });
  const cases = [
    ["live", ssr.turn(ssr.turnOf(conversation({ status: "streaming" })), { isActive: true })],
    [
      "failed",
      ssr.turn(ssr.turnOf(conversation({ error: { code: "PROVIDER_ERROR", message: "upstream failed" } }))),
    ],
    ["text-less", ssr.turn(ssr.turnOf(conversation().slice(0, 3).map((m) => ({ ...m, content: m.role === "user" ? m.content : "" }))))],
  ];
  for (const [label, html] of cases) {
    assert.doesNotMatch(html, /pi-entry-extra/, label);
    assert.deepEqual(probed(html, "extra"), [], label);
  }
});
