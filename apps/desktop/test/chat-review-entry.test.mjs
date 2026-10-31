import {
  readStoreSource,
  readStoreModule,
  readTranscriptModule,
  readTranscriptSource,
} from "./helpers/source-contracts.mjs";
import { readAppSource } from "./helpers/source-contracts.mjs";
import { slotSsr } from "./helpers/slot-ssr.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import test from "node:test";
import {
  reviewChangeFromMessage,
  reviewChangesFromMessages,
  summarizeReviewChanges,
} from "../src/lib/workspace-review.ts";

const transcriptSource = await readTranscriptSource();
const activityItemsSource = await readTranscriptModule("ActivityItems.tsx");
const cardSource = await readFile(
  new URL("../src/components/ReviewChangeCard.tsx", import.meta.url),
  "utf8",
);
const reviewSource = await readFile(
  new URL("../src/components/workpanel/ReviewTab.tsx", import.meta.url),
  "utf8",
);
const messageStylesSource = await readFile(
  new URL("../src/styles/messages.css", import.meta.url),
  "utf8",
);
const workPanelStylesSource = await readFile(
  new URL("../src/styles/work-panel.css", import.meta.url),
  "utf8",
);
const responsiveStylesSource = await readFile(
  new URL("../src/styles/responsive.css", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();
const storeSource = await readStoreSource();
const appStoreSource = await readStoreModule("app-store.ts");
const eventsSource = await readStoreModule("slices/events-slice.ts");
const transcriptSliceSource = await readStoreModule("slices/transcript-slice.ts");

const baseReview = {
  version: 1,
  snapshotId: "snapshot-1",
  messageId: "tool-1",
  path: "src/a.ts",
  operation: "edit",
  status: "modified",
  state: "active",
  additions: 4,
  deletions: 1,
  hunks: [
    {
      header: "@@ -1,2 +1,3 @@",
      lines: [
        { type: "context", text: "const before = true;" },
        { type: "del", text: "const removed = true;" },
        { type: "add", text: "const added = true;" },
      ],
    },
  ],
  reversible: true,
};

function message(overrides = {}) {
  return {
    id: "tool-1",
    role: "tool",
    content: "",
    createdAt: new Date().toISOString(),
    toolName: "Edit",
    toolStatus: "success",
    toolArgs: { path: "src/a.ts" },
    toolResult: { details: { root: "workspace", review: baseReview } },
    ...overrides,
  };
}

test("review evidence is read from the successful message, not Git", () => {
  const change = reviewChangeFromMessage(message());
  assert.equal(change?.path, "src/a.ts");
  assert.equal(change?.status, "modified");
  assert.equal(change?.additions, 4);
  assert.equal(change?.deletions, 1);
  assert.equal(change?.hunks[0].lines[1].type, "del");

  const entries = reviewChangesFromMessages([
    message(),
    message({
      id: "tool-2",
      toolName: "Write",
      toolResult: {
        details: {
          root: "workspace",
          review: {
            ...baseReview,
            snapshotId: "snapshot-2",
            messageId: "tool-2",
            path: "new.ts",
            operation: "write",
            status: "added",
            additions: 3,
            deletions: 0,
          },
        },
      },
    }),
    message({
      id: "tool-3",
      toolResult: {
        details: {
          root: "workspace",
          review: {
            ...baseReview,
            snapshotId: "snapshot-3",
            messageId: "tool-3",
            path: "old.ts",
            status: "deleted",
            additions: 0,
            deletions: 8,
          },
        },
      },
    }),
  ]);
  assert.deepEqual(
    entries.map(({ change }) => [change.status, change.path]),
    [
      ["modified", "src/a.ts"],
      ["added", "new.ts"],
      ["deleted", "old.ts"],
    ],
  );
  assert.deepEqual(summarizeReviewChanges(entries), {
    changeCount: 3,
    activeCount: 3,
    rolledBackCount: 0,
    additions: 7,
    deletions: 9,
  });
});

test("failed and scratch tool rows cannot manufacture review evidence", () => {
  assert.equal(reviewChangeFromMessage(message({ toolStatus: "error" })), null);
  assert.equal(
    reviewChangeFromMessage(
      message({
        toolResult: { details: { root: "scratch", review: baseReview } },
      }),
    ),
    null,
  );
  assert.equal(
    reviewChangeFromMessage(
      message({ toolResult: { details: { root: "workspace" } } }),
    ),
    null,
  );
});

test("a review-backed edit renders only the two-level review row", () => {
  assert.equal(transcriptSource.includes("<WorkspaceChangesEntry />"), false);
  assert.equal(transcriptSource.includes("review-changes-entry"), false);
  // ActivityItems chooses exactly one row: the review card carries the file
  // header for a recorded change, otherwise the generic tool row renders.
  assert.match(
    activityItemsSource,
    /if \(reviewChangeFromMessage\(item\.message\)\) \{\s*return <ReviewChangeCard[\s\S]*?asToolRow\s*\/>;\s*\}/,
  );
  assert.match(activityItemsSource, /<ToolRow\s+key=\{item\.message\.id\}/);
  assert.doesNotMatch(
    activityItemsSource,
    /<ReviewChangeCard message=\{item\.message\} \/>/,
  );
  // The standalone-run and delegate surfaces make the same choice, so no
  // review-backed edit can render both the tool header and the file header.
  assert.match(
    transcriptSource,
    /reviewChangeFromMessage\(segment\.item\.message\)[\s\S]*?asToolRow/,
  );
  assert.doesNotMatch(
    transcriptSource,
    /<ToolRow message=\{item\.message\} \/>[\s\S]*?<ReviewChangeCard message=\{item\.message\} \/>/,
  );
  assert.doesNotMatch(transcriptSource, /workspaceDiff|findWorkspaceChange/);
  assert.match(cardSource, /aria-expanded=\{open\}/);
  assert.match(cardSource, /chat\.reviewChangeShow/);
  assert.match(cardSource, /change\.hunks\.map/);
  assert.match(cardSource, /workspaceReviewRollback|rollbackWorkspaceChange/);
  assert.match(
    storeSource,
    /rollbackWorkspaceChange:[\s\S]*api\.workspaceReviewRollback[\s\S]*withReviewChangeState/,
  );
  assert.doesNotMatch(
    eventsSource,
    /shouldOpenReviewArtifact|toolWorkPanelTab\("review"\)/,
  );
  assert.doesNotMatch(storeSource, /workspaceReviewSessions/);
});

test("a review-backed edit renders one file header and no tool header", async (t) => {
  const ssr = await slotSsr(t);
  const { ActivityItems } = await ssr.load(
    "/src/features/chat/transcript/ActivityItems.tsx",
  );
  const html = ssr.render(
    createElement(ActivityItems, {
      items: [{ kind: "tool", message: message() }],
      isActive: false,
      live: false,
      delegateItems: [],
      delegationStatuses: new Map(),
      delegationTimings: new Map(),
      onUserInteraction: () => {},
    }),
    { sessionId: null },
  );
  assert.equal(html.match(/review-change-card-header/g)?.length, 1);
  assert.match(html, /class="review-change-card is-tool-row/);
  assert.doesNotMatch(html, /tool-row-header/);
});

test("rollback outcomes reach the toast instead of a second card row", () => {
  // The store already reports both outcomes; the card only owns the action.
  assert.match(
    transcriptSliceSource,
    /rollbackConflict[\s\S]{0,120}variant: "warning"/,
  );
  assert.match(
    transcriptSliceSource,
    /rollbackUnavailable[\s\S]{0,120}variant: "warning"/,
  );
  assert.doesNotMatch(cardSource, /rollbackStatus/);
  assert.doesNotMatch(cardSource, /review-change-rollback-note is-warning/);
  assert.doesNotMatch(cardSource, /panel\.review\.rollbackConflict/);
});

test("Review is a session change history and no longer refreshes a Git diff", () => {
  assert.match(reviewSource, /reviewChangesFromMessages\(messages\)/);
  assert.match(reviewSource, /<ReviewChangeCard/);
  assert.match(reviewSource, /panel\.review\.noChanges/);
  assert.doesNotMatch(reviewSource, /workspaceDiff|refreshWorkspaceDiff|api\.workspaceDiff/);
  assert.doesNotMatch(appSource, /reviewRev|refreshWorkspaceDiff|workspaceDiff/);
});

test("review surfaces keep visual state, focus, and motion feedback", () => {
  assert.match(cardSource, /data-state=\{change\.state\}/);
  assert.match(cardSource, /data-status=\{change\.status\}/);
  assert.match(messageStylesSource, /\.review-change-card-header:focus-visible/);
  assert.match(messageStylesSource, /\.review-change-card\[data-status="added"\]/);
  assert.match(messageStylesSource, /@keyframes review-change-reveal/);
  assert.match(workPanelStylesSource, /\.review-toolbar-counts/);
  assert.match(responsiveStylesSource, /\.review-change-card-body\s*\{[\s\S]*animation: none/);
});

test("a recorded change is a single flat row, not a card", () => {
  // Status travels as a git-style letter plus color, never color alone, and
  // the localized word stays in the accessible name.
  assert.match(cardSource, /review-change-card-mark/);
  assert.match(cardSource, /added: "A"[\s\S]*modified: "M"[\s\S]*deleted: "D"/);
  assert.doesNotMatch(
    cardSource,
    /review-change-card-(icon|status|state|main|meta)\b/,
  );
  assert.match(cardSource, /rolledBack"\s*\?\s*`\$\{baseLabel\}/);
  assert.match(
    messageStylesSource,
    /\.review-change-card-mark\s*\{[\s\S]*var\(--review-change-rail\)/,
  );
  // The row borrows the tool-row rhythm: no card border, rail, or shadow.
  const cardRule = messageStylesSource.match(/\n\.review-change-card \{[\s\S]*?\n\}/)?.[0];
  assert.ok(cardRule, "expected a .review-change-card rule");
  assert.doesNotMatch(cardRule, /^\s*(border|box-shadow|background)\s*:/m);
  assert.match(
    messageStylesSource,
    /\.review-change-card-header \{[\s\S]*min-height: 24px/,
  );
  // The Git-diff era file rows are gone; only the +/− counts helper survives.
  assert.doesNotMatch(workPanelStylesSource, /\.diff-file/);
  assert.match(workPanelStylesSource, /\.diff-counts \{/);
});
