import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { catalogs } from "@pi-desktop/i18n";
import { parseProbe, probed, propsProbe, slotMounts, slotSsr } from "./helpers/slot-ssr.mjs";

/*
 * The action-bar slots `userAction` and `assistantAction`
 * (`docs/plugin-plan/ui/user-action/`, `docs/plugin-plan/ui/assistant-action/`)
 * rendered with the production modules. A bar is its left items, its host
 * keys, then its right items; a side shows three items and folds the rest
 * into its own ⋯ menu at the outer end of the bar; every item is fed
 * `{ message, messageId, sessionId, position }`. Server rendering is the
 * first frame, where every ⋯ menu is closed: opening one, closing it on
 * Escape or an outside press, and a throwing item disappearing alone are
 * covered by the Electron E2E.
 */

const { chat } = catalogs.en;
const USER_KEYS = [chat.copy, chat.editMessage, chat.deleteMessage];
const REPLY_KEYS = [chat.copy, chat.forkResponse, chat.retry];

const USER = {
  id: "u1",
  role: "user",
  content: "hello",
  status: "complete",
  createdAt: "2026-09-24T00:00:00.000Z",
};

/** The prompt answered in two parts around a tool call. */
function conversation(overrides = {}) {
  return [
    USER,
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
    { id: "a2", role: "assistant", content: "It says x.", status: "complete", createdAt: "2026-09-24T00:00:03.000Z", ...overrides },
  ];
}

async function bars(t) {
  const ssr = await slotSsr(t);
  const { MessageRow } = await ssr.load("/src/features/chat/transcript/MessageRow.tsx");
  const { AssistantTurn } = await ssr.load("/src/features/chat/transcript/AssistantTurn.tsx");
  const { buildTranscriptEntries } = await ssr.load("/src/lib/assistant-turns.ts");
  return {
    ...ssr,
    row: (message = USER) => ssr.render(createElement(MessageRow, { message, isRunning: false })),
    turn: (messages = conversation(), isActive = false) => {
      const { entries } = buildTranscriptEntries(messages);
      const entry = entries.find((candidate) => candidate.kind === "assistant-turn");
      return ssr.render(createElement(AssistantTurn, { entry, isActive }));
    },
  };
}

/**
 * What the first action bar in `html` shows, in order: a host key by its
 * label, a plugin item as `probe:position`, a ⋯ menu as `⋯side`.
 */
function barOf(html) {
  const start = html.indexOf('<div class="message-actions">');
  assert.ok(start >= 0, "the row has an action bar");
  const end = html.indexOf('<div class="pi-entry-extra-stack">', start);
  const bar = html.slice(start, end < 0 ? undefined : end);
  const shown = [];
  const token =
    /<div class="pi-action-overflow" data-side="(\w+)">|<output data-probe="([^"]*)">([^<]*)<\/output>|<button\b([^>]*)>/g;
  for (const [, menuSide, probe, props, button] of bar.matchAll(token)) {
    if (menuSide) shown.push(`⋯${menuSide}`);
    else if (probe) shown.push(`${probe}:${parseProbe(props).position}`);
    else if (!button.includes("pi-action-overflow-btn")) shown.push(button.match(/aria-label="([^"]*)"/)[1]);
  }
  return shown;
}

/** `html` without its plugin items and ⋯ menus: the host's own markup. */
function hostOnly(html) {
  return html
    .replaceAll(/<div class="pi-plugin-slot"[^>]*><output data-probe="[^"]*">[^<]*<\/output><\/div>/g, "")
    .replaceAll(/<div class="pi-action-overflow" data-side="\w+"><button\b[^>]*>⋯<\/button><\/div>/g, "");
}

test("a bar keeps exactly its host keys when no plugin adds to its slot", async (t) => {
  const ssr = await bars(t);
  const row = ssr.row();
  const turn = ssr.turn();
  assert.deepEqual(barOf(row), USER_KEYS);
  assert.deepEqual(barOf(turn), REPLY_KEYS);

  ssr.register("demo.a", { slot: "assistantAction", component: propsProbe("reply") });
  assert.equal(ssr.row(), row, "an assistantAction item is not on a user's bar");
  ssr.clear();
  ssr.register("demo.a", { slot: "userAction", component: propsProbe("user") });
  assert.equal(ssr.turn(), turn, "a userAction item is not on a reply's bar");
});

test("items sit around the host keys, the left side before them and the right after", async (t) => {
  const ssr = await bars(t);
  const plain = ssr.row();
  ssr.register("demo.a", { slot: "userAction", component: propsProbe("a") });
  ssr.register("demo.b", { slot: "userAction", component: propsProbe("b"), positions: ["left"] });
  ssr.register("demo.c", { slot: "userAction", component: propsProbe("c"), positions: ["right"] });
  const html = ssr.row();

  assert.deepEqual(barOf(html), ["a:left", "b:left", ...USER_KEYS, "a:right", "c:right"]);
  assert.deepEqual(slotMounts(html), [
    ["demo.a", "userAction"],
    ["demo.b", "userAction"],
    ["demo.a", "userAction"],
    ["demo.c", "userAction"],
  ]);
  assert.equal(hostOnly(html), plain, "the host keys and the row around them are untouched");

  const message = { id: "u1", role: "user", content: "hello", createdAt: USER.createdAt };
  assert.deepEqual(probed(html, "a"), [
    { message, messageId: "u1", sessionId: "session-1", position: "left" },
    { message, messageId: "u1", sessionId: "session-1", position: "right" },
  ]);
});

test("past three items a side folds the rest into a ⋯ menu at the bar's outer end", async (t) => {
  const ssr = await bars(t);
  const plain = ssr.turn();
  const left = ["l1", "l2", "l3", "l4"].map((label) =>
    ssr.register("demo.a", { slot: "assistantAction", component: propsProbe(label), positions: ["left"] }),
  );
  for (const label of ["r1", "r2", "r3", "r4", "r5"]) {
    ssr.register("demo.b", { slot: "assistantAction", component: propsProbe(label), positions: ["right"] });
  }
  const html = ssr.turn();

  assert.deepEqual(barOf(html), [
    "⋯left", "l1:left", "l2:left", "l3:left",
    ...REPLY_KEYS,
    "r1:right", "r2:right", "r3:right", "⋯right",
  ]);
  for (const side of ["left", "right"]) {
    assert.ok(
      html.includes(
        `<div class="pi-action-overflow" data-side="${side}"><button type="button" class="copy-btn icon pi-action-overflow-btn" aria-label="${chat.actionSlotMore}" title="${chat.actionSlotMore}" aria-expanded="false">⋯</button></div>`,
      ),
      `the ${side} menu starts closed, with no panel`,
    );
  }
  for (const folded of ["l4", "r4", "r5"]) assert.deepEqual(probed(html, folded), [], folded);
  assert.equal(hostOnly(html), plain, "the host keys never fold");

  // A side reflows as soon as its registrations change.
  left[0]();
  assert.deepEqual(barOf(ssr.turn()), [
    "l2:left", "l3:left", "l4:left",
    ...REPLY_KEYS,
    "r1:right", "r2:right", "r3:right", "⋯right",
  ]);
});

test("a reply's items act on the answer message the host keys act on", async (t) => {
  const ssr = await bars(t);
  ssr.register("demo.a", { slot: "assistantAction", component: propsProbe("reply"), positions: ["right"] });
  const html = ssr.turn();
  assert.deepEqual(barOf(html), [...REPLY_KEYS, "reply:right"]);
  // Regenerate and Branch act on the last answer message; Copy copies the
  // whole turn's text.
  assert.deepEqual(probed(html, "reply"), [
    {
      message: {
        id: "a2",
        role: "assistant",
        content: "Let me look.\n\nIt says x.",
        createdAt: "2026-09-24T00:00:03.000Z",
      },
      messageId: "a2",
      sessionId: "session-1",
      position: "right",
    },
  ]);
  assert.deepEqual(
    probed(ssr.turn(conversation({ status: "streaming" }), true), "reply"),
    [],
    "a reply still streaming has no bar to add to",
  );
});

test("a session message carries userAction around Copy; other rows keep a plugin-free bar", async (t) => {
  const ssr = await bars(t);
  const system = { ...USER, id: "s1", role: "system" };
  const plainSystem = ssr.row(system);
  ssr.register("demo.a", { slot: "userAction", component: propsProbe("user") });

  const delivered = {
    ...USER,
    sessionMessage: {
      messageId: "d1",
      sourceSessionId: "session-0",
      sourceTitle: "Parent review",
      targetSessionId: "session-1",
      kind: "task",
    },
  };
  const html = ssr.row(delivered);
  assert.deepEqual(barOf(html), ["user:left", chat.copy, "user:right"]);
  assert.deepEqual(
    probed(html, "user").map((props) => props.message.role),
    ["user", "user"],
  );
  assert.equal(ssr.row(system), plainSystem);
});
