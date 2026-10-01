import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { probed, propsProbe, slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The keyed `toolCard` slot (`docs/plugin-plan/ui/tool-card/`) rendered with
 * the production modules: a call of a plugin's own tool renders the card that
 * plugin registered for it in place of the host card, fed the call's
 * projection; every other row keeps the host card. Server rendering is the
 * first frame of a mount: the merged running beat is driven below as the
 * decision it is, and a card that throws or unloads handing the call back to
 * the host card is covered by the Electron E2E.
 */

const PLUGIN = "demo.lab";
const QUALIFIED = "plugin_demo_lab_lookup";

const call = (overrides = {}) => ({
  id: "t1",
  role: "tool",
  content: "",
  status: "complete",
  createdAt: "2026-09-24T00:00:02.000Z",
  toolName: QUALIFIED,
  toolCallId: "call-1",
  toolArgs: { q: "x" },
  toolStatus: "success",
  toolResult: { rows: 1 },
  toolDurationMs: 12,
  ...overrides,
});

async function rows(t) {
  const ssr = await slotSsr(t);
  const { ToolRow } = await ssr.load("/src/features/chat/transcript/ToolRow.tsx");
  const cadence = await ssr.load("/src/features/chat/transcript/tool-card-props.ts");
  return {
    ...ssr,
    ...cadence,
    row: (message, props = {}) => ssr.render(createElement(ToolRow, { message, ...props })),
    claim: () =>
      ssr.register(PLUGIN, { slot: "toolCard", toolName: "lookup", component: propsProbe("card") }, ["lookup"]),
  };
}

test("a call of the plugin's own tool renders its card instead of the host card", async (t) => {
  const ssr = await rows(t);
  assert.match(ssr.row(call()), /^<div class="tool-row /, "the host card until a plugin claims the tool");
  ssr.claim();
  const html = ssr.row(call());
  assert.match(
    html,
    /^<div class="pi-plugin-slot" data-pi-plugin="demo.lab" data-pi-slot="toolCard"><output data-probe="card">[^<]*<\/output><\/div>$/,
    "the whole card is the plugin's",
  );
  assert.deepEqual(probed(html, "card"), [
    {
      toolName: "lookup",
      toolCallId: "call-1",
      toolArgs: { q: "x" },
      toolStatus: "success",
      toolResult: { rows: 1 },
      durationMs: 12,
      messageId: "t1",
      sessionId: "session-1",
    },
  ]);
});

test("a failed call reaches the card as data, a running one without a result", async (t) => {
  const ssr = await rows(t);
  ssr.claim();
  assert.deepEqual(
    probed(ssr.row(call({ toolStatus: "error", toolResult: "no such table" })), "card"),
    [
      {
        toolName: "lookup",
        toolCallId: "call-1",
        toolArgs: { q: "x" },
        toolStatus: "error",
        toolError: "no such table",
        durationMs: 12,
        messageId: "t1",
        sessionId: "session-1",
      },
    ],
    "what the failed tool returned is toolError, never toolResult",
  );
  assert.deepEqual(
    probed(
      ssr.row(call({ toolStatus: "running", toolCallId: undefined, toolResult: undefined, toolDurationMs: undefined })),
      "card",
    ),
    [
      {
        toolName: "lookup",
        toolCallId: "t1",
        toolArgs: { q: "x" },
        toolStatus: "running",
        messageId: "t1",
        sessionId: "session-1",
      },
    ],
    "a call without its own id is known by its message id",
  );
});

test("denied calls, topology nodes and every other tool keep the host card", async (t) => {
  const ssr = await rows(t);
  const cases = [
    ["a denied call", call({ toolStatus: "denied" }), {}],
    ["a topology node", call(), { variant: "topology" }],
    ["a host tool", call({ toolName: "read" }), {}],
    ["the bare tool name", call({ toolName: "lookup" }), {}],
    ["another plugin's tool of the same name", call({ toolName: "plugin_demo_other_lookup" }), {}],
  ];
  const plain = cases.map(([, message, props]) => ssr.row(message, props));
  const dispose = ssr.claim();
  cases.forEach(([label, message, props], index) => {
    assert.equal(ssr.row(message, props), plain[index], label);
  });

  const hostCard = ssr.row(call());
  dispose();
  assert.notEqual(hostCard, ssr.row(call()));
  assert.match(ssr.row(call()), /^<div class="tool-row /, "the host card is back once the card leaves");
});

test("running updates merge onto a 500ms beat; a transition or a finished call pushes at once", async (t) => {
  const { TOOL_CARD_RUNNING_INTERVAL_MS, shouldEmitToolCard } = await rows(t);
  assert.equal(TOOL_CARD_RUNNING_INTERVAL_MS, 500);
  const cases = [
    ["running inside the beat", 1_000, "running", "running", 1_499, false],
    ["running on the beat", 1_000, "running", "running", 1_500, true],
    ["running past the beat", 1_000, "running", "running", 2_200, true],
    ["running to success", 1_000, "running", "success", 1_001, true],
    ["running to error", 1_000, "running", "error", 1_001, true],
    ["a finished call's update", 1_000, "success", "success", 1_001, true],
  ];
  for (const [label, lastAt, lastStatus, nextStatus, now, emits] of cases) {
    assert.equal(shouldEmitToolCard(lastAt, lastStatus, nextStatus, now), emits, label);
  }
  assert.equal(shouldEmitToolCard(1_000, "running", "running", 1_100, 100), true, "the beat is a parameter");
});

test("the card's status vocabulary is running, error or success", async (t) => {
  const { toolCardStatusOf } = await rows(t);
  const statuses = ["running", "error", "success", undefined].map((toolStatus) =>
    toolCardStatusOf(call({ toolStatus })),
  );
  assert.deepEqual(statuses, ["running", "error", "success", "success"]);
});
