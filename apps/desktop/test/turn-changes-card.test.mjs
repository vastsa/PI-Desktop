import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { slotSsr, propsProbe } from "./helpers/slot-ssr.mjs";
import { summarizeTurnChanges } from "../src/lib/turn-changed-files.ts";
import {
  currentReviewFocusRequest,
  requestReviewFocus,
} from "../src/lib/review-focus-request.ts";

/*
 * The per-turn changed-files summary (issue #1891, design 10): one card under
 * a finished reply, built only from the turn's message-owned review records.
 */

let sequence = 0;

function edit(path, review = {}, overrides = {}) {
  sequence += 1;
  const id = `tool-${sequence}`;
  return {
    id,
    role: "tool",
    content: "",
    status: "complete",
    createdAt: `2026-10-28T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    toolName: "Edit",
    toolCallId: `call-${sequence}`,
    toolStatus: "success",
    toolArgs: { path },
    toolResult: {
      details: {
        root: "workspace",
        review: {
          version: 1,
          snapshotId: `snap-${sequence}`,
          messageId: id,
          path,
          operation: "edit",
          status: "modified",
          state: "active",
          additions: 1,
          deletions: 1,
          hunks: [],
          reversible: true,
          ...review,
        },
      },
    },
    ...overrides,
  };
}

test("one file edited several times is one row with merged counts and status", () => {
  const summary = summarizeTurnChanges([
    edit("src/new.ts", { status: "added", operation: "write", additions: 10, deletions: 0 }),
    edit("src/new.ts", { additions: 3, deletions: 2 }),
    edit("src/app.ts", { additions: 4, deletions: 1 }),
    edit("src/app.ts", { additions: 1, deletions: 0 }),
    edit("src/old.ts", { additions: 2, deletions: 0 }),
    edit("src/old.ts", { status: "deleted", operation: "delete", additions: 0, deletions: 9 }),
  ]);
  assert.deepEqual(
    summary.files.map(({ path, status, additions, deletions, snapshotIds }) => [
      path, status, additions, deletions, snapshotIds.length,
    ]),
    [
      ["src/new.ts", "added", 13, 2, 2],
      ["src/app.ts", "modified", 5, 1, 2],
      ["src/old.ts", "deleted", 2, 9, 2],
    ],
  );
  assert.equal(summary.additions, 20);
  assert.equal(summary.deletions, 12);
  assert.equal(summary.directoryCount, 1);
});

test("rolled-back changes stay listed; a file is rolled back only when every edit is", () => {
  const summary = summarizeTurnChanges([
    edit("a.ts", { state: "rolledBack" }),
    edit("b.ts", { state: "rolledBack" }),
    edit("b.ts"),
  ]);
  assert.deepEqual(
    summary.files.map((file) => [file.path, file.rolledBack]),
    [["a.ts", true], ["b.ts", false]],
  );
});

test("failed, scratch, and non-file tool messages add nothing", () => {
  const summary = summarizeTurnChanges([
    edit("a.ts", {}, { toolStatus: "error" }),
    edit("b.ts", {}, { toolResult: { details: { root: "scratch", review: {} } } }),
    { id: "r", role: "tool", content: "", createdAt: "", toolName: "Read", toolStatus: "success" },
  ]);
  assert.deepEqual(summary.files, []);
});

test("a focus request carries its snapshots, expansion, and a fresh sequence", () => {
  requestReviewFocus([], { expand: true });
  const before = currentReviewFocusRequest();
  requestReviewFocus(["s1", "s2"], { expand: true });
  const first = currentReviewFocusRequest();
  assert.deepEqual(first.snapshotIds, ["s1", "s2"]);
  assert.equal(first.expand, true);
  assert.notEqual(first, before, "an empty request is ignored, a real one replaces it");
  requestReviewFocus(["s1"], { expand: false });
  assert.ok(currentReviewFocusRequest().seq > first.seq);
});

function turnMessages(tools, replyOverrides = {}) {
  return [
    { id: "u1", role: "user", content: "fix it", status: "complete", createdAt: "2026-10-28T00:00:00.000Z" },
    ...tools,
    {
      id: "a-reply",
      role: "assistant",
      content: "Done.",
      status: "complete",
      createdAt: "2026-10-28T00:01:00.000Z",
      ...replyOverrides,
    },
  ];
}

async function renderer(t) {
  const ssr = await slotSsr(t);
  const { AssistantTurn } = await ssr.load("/src/features/chat/transcript/AssistantTurn.tsx");
  const { buildTranscriptEntries } = await ssr.load("/src/lib/assistant-turns.ts");
  const turnOf = (messages) =>
    buildTranscriptEntries(messages).entries.find((entry) => entry.kind === "assistant-turn");
  return {
    ...ssr,
    turn: (messages, props = {}) =>
      ssr.render(createElement(AssistantTurn, { entry: turnOf(messages), isActive: false, ...props })),
  };
}

function rows(html) {
  return [...html.matchAll(/class="turn-changes-row"[^>]*>[\s\S]*?<\/button>/g)];
}

test("a finished turn with a few files gets relaxed rows below the reply, above entry extras", async (t) => {
  const ssr = await renderer(t);
  ssr.register("demo.a", { slot: "entryExtra", component: propsProbe("extra") });
  const html = ssr.turn(turnMessages([
    edit("src/a.ts", { status: "added", operation: "write", additions: 19, deletions: 0 }),
    edit("src/b.ts", { additions: 12, deletions: 4 }),
  ]));
  assert.match(html, /<section class="turn-changes-card" aria-label="Files changed this turn">/);
  assert.match(html, /Changes this turn/);
  assert.match(html, /2 files/);
  assert.match(html, /class="turn-changes-body"/, "two files use the relaxed rows");
  assert.equal(rows(html).length, 2);
  assert.match(html, /data-status="added"[^>]*aria-label="Open Added changes for src[^"]*a\.ts in Review \(19 additions, 0 deletions\)"/);
  assert.doesNotMatch(html, /turn-changes-more|turn-changes-view-all/);
  const reply = html.indexOf("Done.");
  const card = html.indexOf("turn-changes-card");
  const extra = html.indexOf("pi-entry-extra-stack");
  assert.ok(reply < card && card < extra, "reply, then the card, then plugin extras");
});

test("many files switch to dense rows, cap at twelve, and offer the Review panel", async (t) => {
  const ssr = await renderer(t);
  const tools = Array.from({ length: 15 }, (_, index) =>
    edit(`pkg/dir${index % 3}/file${index}.ts`, { additions: 2, deletions: 1 }));
  const html = ssr.turn(turnMessages(tools));
  assert.match(html, /class="turn-changes-body is-dense"/);
  assert.match(html, /15 files · 3 dirs/);
  assert.equal(rows(html).length, 12);
  assert.match(html, /\+3 more/);
  assert.match(html, /View all 15 files in Review/);
  assert.match(html, /\+30/);
  assert.match(html, /−15/);
});

test("rolled-back files are marked in the row and its accessible name", async (t) => {
  const ssr = await renderer(t);
  const html = ssr.turn(turnMessages([edit("src/a.ts", { state: "rolledBack" })]));
  assert.match(html, /data-rolled-back="true"/);
  assert.match(html, /class="turn-changes-row"[^>]*aria-label="[^"]*a\.ts[^"]*· Rolled back"/);
});

test("no card for a turn without file writes, a live turn, or a failed turn", async (t) => {
  const ssr = await renderer(t);
  assert.doesNotMatch(ssr.turn(turnMessages([])), /turn-changes-card/);
  const tools = [edit("src/a.ts")];
  assert.doesNotMatch(
    ssr.turn(turnMessages(tools), { isActive: true }),
    /turn-changes-card/,
    "streaming keeps the reply-slot mount condition",
  );
  assert.doesNotMatch(
    ssr.turn(turnMessages(tools, { error: { code: "X", message: "boom" } })),
    /turn-changes-card/,
  );
});

test("the card stays borderless and the Review tab honors focus requests", async () => {
  const css = await readFile(new URL("../src/styles/turn-changes.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /^\s*border(-top|-bottom|-left|-right)?\s*:/m);
  assert.doesNotMatch(css, /box-shadow/);
  assert.match(css, /\.turn-changes-card \{[\s\S]*?background: var\(--ds-tile\)/);
  const reviewTab = await readFile(
    new URL("../src/components/workpanel/ReviewTab.tsx", import.meta.url),
    "utf8",
  );
  assert.match(reviewTab, /useReviewFocusRequest\(\)/);
  assert.match(reviewTab, /openRequest=\{/);
  assert.match(reviewTab, /scrollIntoView/);
});
