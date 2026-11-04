import type { ToolAction } from "./tool-display";

/*
 * The header of an activity group says what the group did.
 *
 * A folded group is a single line, so "12 tool actions" cannot be the whole
 * story: the reader has to know whether the agent searched, read, edited, or ran
 * commands without opening the group. The label therefore names the actions the
 * group actually contains, joined with the locales' own list wording, and
 * appends the call count as a separate token.
 *
 * Only three actions are named. Naming all of them does not fit a transcript
 * band, and the four most common mixes are already unreadable at 320px; beyond
 * three the label says "and more" and the group itself carries the detail.
 */

/** Reasoning plus the tool actions, in the order a label lists them. */
export type ActivityBucketId = "thinking" | ToolAction;

/**
 * Reading order, not priority.
 *
 * Reasoning leads because it is what the reader most often probes for, and
 * `run` sits after the file work so a Chinese label ends on a verb phrase
 * ("搜索、读取并执行命令") instead of starting the list with a command.
 */
export const ACTIVITY_BUCKET_ORDER: readonly ActivityBucketId[] = [
  "thinking",
  "search",
  "read",
  "list",
  "write",
  "edit",
  "run",
  "fetch",
  "fork",
  "delegate",
  "use",
  "todo",
];

/** Distinct actions a label names before it summarizes the rest. */
export const ACTIVITY_LABEL_MAX_BUCKETS = 3;

const BUCKET_LABEL_KEYS: Record<ActivityBucketId, string> = {
  thinking: "chat.activityBucket.thinking",
  search: "chat.activityBucket.search",
  read: "chat.activityBucket.read",
  list: "chat.activityBucket.list",
  write: "chat.activityBucket.write",
  edit: "chat.activityBucket.edit",
  run: "chat.activityBucket.run",
  fetch: "chat.activityBucket.fetch",
  fork: "chat.activityBucket.fork",
  delegate: "chat.activityBucket.delegate",
  use: "chat.activityBucket.use",
  todo: "chat.activityBucket.todo",
};

export type ActivityBucket = {
  id: ActivityBucketId;
  /** How many visible rows of this action the group contains. */
  count: number;
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

function bucketRank(id: ActivityBucketId): number {
  return ACTIVITY_BUCKET_ORDER.indexOf(id);
}

/**
 * The actions a label names, plus how many distinct actions it leaves out.
 *
 * Selection ranks by call count so the busiest actions survive the three-name
 * cap, then renders in reading order. Renders can therefore only change
 * membership when an action enters or leaves the top three - a stream that keeps
 * incrementing one count never reorders the label.
 */
export function activityLabelBuckets(buckets: readonly ActivityBucket[]): {
  named: ActivityBucket[];
  hidden: number;
} {
  const present = buckets.filter((bucket) => bucket.count > 0);
  const ranked = [...present].sort(
    (left, right) => right.count - left.count || bucketRank(left.id) - bucketRank(right.id),
  );
  const named = ranked.slice(0, ACTIVITY_LABEL_MAX_BUCKETS);
  named.sort((left, right) => bucketRank(left.id) - bucketRank(right.id));
  return { named, hidden: ranked.length - named.length };
}

/** The localized "what it did" phrase, e.g. `搜索并读取文件`. */
export function activityBucketPhrase(
  named: readonly ActivityBucket[],
  hidden: number,
  t: Translate,
): string {
  const words = named.map((bucket) => t(BUCKET_LABEL_KEYS[bucket.id]));
  if (words.length === 0) return "";
  if (words.length === 1) return words[0];
  if (words.length === 2) {
    return t("chat.activityJoin.two", { a: words[0], b: words[1] });
  }
  const list = { a: words[0], b: words[1], c: words[2] };
  return hidden > 0
    ? t("chat.activityJoin.threeMore", list)
    : t("chat.activityJoin.three", list);
}

/**
 * The count token beside the phrase.
 *
 * Reasoning is not an operation, so it never enters this number: a group of
 * three thinking rows and nine reads states nine operations and still names the
 * reasoning in front of it. A group with nothing but reasoning counts steps
 * instead, because "0 operations" would be the only alternative.
 */
export function activityOpsText(
  tools: number,
  thinking: number,
  t: Translate,
): string {
  if (tools > 0) return t("chat.activityOps", { count: tools });
  if (thinking > 0) return t("chat.activityThinkingSteps", { count: thinking });
  return "";
}
