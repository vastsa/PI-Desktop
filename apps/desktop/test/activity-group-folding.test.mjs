import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";
import { readTranscriptModule } from "./helpers/source-contracts.mjs";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { activityGroupStartsOpen, thinkingRowStartsOpen } = await import(
  "../src/lib/activity-group-folding.ts"
);
const {
  ACTIVITY_LABEL_MAX_BUCKETS,
  activityBucketPhrase,
  activityLabelBuckets,
  activityOpsText,
} = await import("../src/lib/activity-group-label.ts");
const { catalogs } = await import("../../../packages/i18n/src/index.ts");
const { flattenCatalog } = await import("../../../packages/i18n/src/locale-info.ts");

/** Minimal i18next stand-in: plural suffix, then `{{name}}` interpolation. */
function translator(catalog) {
  const copy = flattenCatalog(catalog);
  return (key, options = {}) => {
    const plural =
      options.count === undefined ? undefined : options.count === 1 ? "one" : "other";
    const template =
      (plural && copy[`${key}_${plural}`]) ??
      copy[`${key}_other`] ??
      copy[key] ??
      `!${key}`;
    return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ""));
  };
}

const buckets = (...pairs) => pairs.map(([id, count]) => ({ id, count }));

test("a settled group folds by default and follows the switch", () => {
  // The old size tier is gone: a two-row group and a twenty-row group answer the
  // same way, because the setting - not the row count - decides.
  for (const collapseSettled of [true]) {
    assert.equal(
      activityGroupStartsOpen({ turnActive: false, groupActive: false, collapseSettled }),
      false,
    );
  }
  assert.equal(
    activityGroupStartsOpen({ turnActive: false, groupActive: false, collapseSettled: false }),
    true,
    "turning auto-collapse off keeps every settled group open",
  );
  assert.equal(ACTIVITY_LABEL_MAX_BUCKETS, 3);
});

test("live work never folds", () => {
  for (const collapseSettled of [true, false]) {
    assert.equal(
      activityGroupStartsOpen({ turnActive: true, groupActive: false, collapseSettled }),
      true,
      "a running turn keeps every group visible",
    );
    assert.equal(
      activityGroupStartsOpen({ turnActive: false, groupActive: true, collapseSettled }),
      true,
      "a group that still owns live work keeps its rows visible",
    );
  }
});

test("reasoning stays open only while the live turn is generating it", () => {
  assert.equal(thinkingRowStartsOpen({ streaming: true, collapseSettled: true }), true);
  assert.equal(thinkingRowStartsOpen({ streaming: false, collapseSettled: true }), false);
  assert.equal(thinkingRowStartsOpen({ streaming: false, collapseSettled: false }), true);
});

test("the group label names what the group did", () => {
  const t = translator(catalogs["zh-CN"]);
  const label = (entries, tools, thinking) => {
    const { named, hidden } = activityLabelBuckets(entries);
    return `${activityBucketPhrase(named, hidden, t)} · ${activityOpsText(tools, thinking, t)}`;
  };
  assert.equal(
    label(buckets(["search", 3], ["read", 9]), 12, 0),
    "搜索并读取文件 · 12 次操作",
  );
  assert.equal(label(buckets(["read", 9]), 9, 0), "读取文件 · 9 次操作");
  assert.equal(label(buckets(["run", 8]), 8, 0), "执行命令 · 8 次操作");
  assert.equal(
    label(buckets(["thinking", 3], ["search", 3], ["read", 9]), 12, 3),
    "进行了思考、搜索并读取文件 · 12 次操作",
    "reasoning is named but never counted as an operation",
  );
  assert.equal(
    label(buckets(["thinking", 2]), 0, 2),
    "进行了思考 · 2 段",
    "a reasoning-only group counts steps instead of operations",
  );
});

test("labels cap at three actions and summarize the rest", () => {
  const t = translator(catalogs["zh-CN"]);
  const phrase = (entries) => {
    const { named, hidden } = activityLabelBuckets(entries);
    return activityBucketPhrase(named, hidden, t);
  };
  assert.equal(
    phrase(buckets(["search", 10], ["read", 9], ["edit", 8], ["run", 2])),
    "搜索、读取文件、编辑文件等",
    "the busiest three are named and the rest is summarized",
  );
  assert.equal(
    phrase(buckets(["run", 5], ["search", 1], ["read", 1], ["edit", 1])),
    "搜索、读取文件、执行命令等",
    "selection ranks by count, then renders in reading order",
  );
  // Counting up never reshuffles the label: membership is what changes it.
  assert.deepEqual(
    activityLabelBuckets(buckets(["read", 2], ["search", 1])).named.map((b) => b.id),
    activityLabelBuckets(buckets(["read", 7], ["search", 1])).named.map((b) => b.id),
  );
  assert.deepEqual(
    activityLabelBuckets(buckets(["read", 2], ["search", 1])).named.map((b) => b.id),
    ["search", "read"],
  );
  // A new action entering the top three is the only reordering event.
  assert.equal(activityOpsText(0, 0, t), "", "an empty group prints no count");
});

test("every locale carries the label fragments the header composes", async () => {
  const { ACTIVITY_BUCKET_ORDER } = await import("../src/lib/activity-group-label.ts");
  for (const [locale, catalog] of Object.entries(catalogs)) {
    const t = translator(catalog);
    // Every action the classifier can produce must have a localized noun in
    // every shipped locale, or a group header would print a raw key.
    for (const id of ACTIVITY_BUCKET_ORDER) {
      const word = t(`chat.activityBucket.${id}`);
      assert.doesNotMatch(word, /!/, `${locale} is missing the "${id}" bucket label`);
    }
    const { named, hidden } = activityLabelBuckets(
      buckets(["thinking", 1], ["search", 2], ["read", 3], ["edit", 1]),
    );
    const phrase = activityBucketPhrase(named, hidden, t);
    assert.doesNotMatch(phrase, /!/, `${locale} is missing a bucket or join translation`);
    assert.equal(phrase.includes("{{"), false, `${locale} left an interpolation raw`);
    const ops = activityOpsText(12, 3, t);
    assert.doesNotMatch(ops, /!/, `${locale} is missing the operation count`);
    assert.equal(ops.includes("{{"), false, `${locale} left the count raw`);
    assert.equal(activityOpsText(0, 4, t).includes("!"), false, `${locale} lacks the step count`);
  }
});

test("the group header states composition and count and drops the issue badge", async () => {
  const [group, items, activityGroup, styles] = await Promise.all([
    readTranscriptModule("ProcessActivityGroup.tsx"),
    readTranscriptModule("ActivityItems.tsx"),
    readTranscriptModule("ActivityGroup.tsx"),
    loadStyles(),
  ]);
  assert.match(group, /activityBucketPhrase\(/);
  assert.match(group, /activityOpsText\(/);
  assert.match(group, /className="tool-activity-count tool-activity-ops"/);
  // Failures stay on the tool row that failed; the group header repeats none.
  assert.doesNotMatch(group, /activity-issue-count/);
  assert.doesNotMatch(group, /activityFailures/);
  assert.doesNotMatch(group, /activityIncludesThinking/);
  // The count token is the part that never truncates.
  assert.match(styles, /\.tool-activity-count\.tool-activity-ops\s*\{[^}]*flex:\s*none;/);
  assert.match(styles, /\.tool-activity-label\s*\{[^}]*text-overflow:\s*ellipsis;/);
  // Both nested levels read their own switch; neither inherits the other.
  assert.match(
    activityGroup,
    /activityGroupStartsOpen\(\{\s*turnActive,\s*groupActive: live,\s*collapseSettled: collapseSettledGroups,\s*\}\)/,
  );
  assert.match(items, /autoOpen=\{thinkingRowStartsOpen\(\{ streaming, collapseSettled: collapseThinking \}\)\}/);
});
