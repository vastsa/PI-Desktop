import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
import { readTranscriptModule } from "./helpers/source-contracts.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { ACTIVITY_GROUP_AUTO_OPEN_MAX_ITEMS, activityGroupStartsOpen } = await import(
  "../src/lib/activity-group-folding.ts"
);

const items = (count, kind = "tool") =>
  Array.from({ length: count }, () => ({ kind }));
const settled = {
  subagentTopology: false,
  turnActive: false,
  groupActive: false,
};

test("a settled group of plain tool rows follows the small-group rule", () => {
  assert.equal(ACTIVITY_GROUP_AUTO_OPEN_MAX_ITEMS, 4);
  assert.equal(activityGroupStartsOpen(items(4), settled), true);
  assert.equal(activityGroupStartsOpen(items(5), settled), false);
});

test("work the turn still owns stays open regardless of group size", () => {
  assert.equal(
    activityGroupStartsOpen(items(20), { ...settled, turnActive: true }),
    true,
    "an assistant turn that is still running keeps every group visible",
  );
  assert.equal(
    activityGroupStartsOpen(items(20), { ...settled, groupActive: true }),
    true,
    "a group that still owns live work keeps its rows visible",
  );
  assert.equal(
    activityGroupStartsOpen(items(20), { ...settled, subagentTopology: true }),
    true,
    "Task topology keeps its released open default",
  );
});

test("reasoning the reader asked to see never folds away", () => {
  assert.equal(
    activityGroupStartsOpen([...items(20), { kind: "thinking" }], settled),
    true,
    "a visible Thinking row is reader-requested content",
  );
  // Reasoning hidden by `Show thinking` never reaches this list, so a group of
  // plain tool rows is still allowed to fold.
  assert.equal(activityGroupStartsOpen(items(20), settled), false);
});

test("issue counters stay on one inline line in the group header", async () => {
  const [styles, groupSource] = await Promise.all([
    loadStyles(),
    readTranscriptModule("ProcessActivityGroup.tsx"),
  ]);
  assert.match(groupSource, /className="activity-issue-count"/);
  assert.match(
    groupSource,
    /<IconCircleAlert size=\{14\} aria-hidden \/>\s*<span>\{t\("chat\.activityFailures"/,
  );
  const badge = styles.match(/\.activity-issue-count \{([^}]*)\}/)?.[1];
  assert.ok(badge, "the activity issue counter has no layout rule");
  assert.match(badge, /display:\s*inline-flex;/);
  assert.match(badge, /align-items:\s*center;/);
  assert.match(badge, /white-space:\s*nowrap;/);
  assert.match(
    styles,
    /\.activity-issue-count > span \{[^}]*text-overflow:\s*ellipsis;/,
  );
  // The top-level turn header still carries no issue count at all.
  assert.doesNotMatch(styles, /\.turn-process-error/);
});
