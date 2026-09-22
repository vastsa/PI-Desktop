import {
  normalizeToolName,
  type DiffHunk,
  type ReviewChange,
  type ReviewChangeState,
  type ReviewChangeStatus,
  type UiMessage,
} from "@pi-desktop/shared";


const REVIEW_CHANGE_TOOLS = new Set(["write", "edit"]);
const REVIEW_CHANGE_STATUSES = new Set<ReviewChangeStatus>([
  "added",
  "modified",
  "deleted",
]);
const REVIEW_CHANGE_OPERATIONS = new Set(["write", "edit", "delete"]);
const REVIEW_CHANGE_STATES = new Set<ReviewChangeState>([
  "active",
  "rolledBack",
]);

export type ReviewChangeEntry = {
  message: UiMessage;
  change: ReviewChange;
};

export type ReviewChangesSummary = {
  changeCount: number;
  activeCount: number;
  rolledBackCount: number;
  additions: number;
  deletions: number;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function toolResultDetails(message: UiMessage): Record<string, unknown> | null {
  return recordValue(recordValue(message.toolResult)?.details);
}

function parseHunks(value: unknown): DiffHunk[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((hunk) => {
    const record = recordValue(hunk);
    const header = nonEmptyString(record?.header);
    if (!header || !Array.isArray(record?.lines)) return [];
    const lines: DiffHunk["lines"] = record.lines.flatMap((line) => {
      const lineRecord = recordValue(line);
      const type = lineRecord?.type;
      const text = typeof lineRecord?.text === "string" ? lineRecord.text : null;
      const lineType =
        type === "add" || type === "del" || type === "context" ? type : null;
      if (
        text === null ||
        lineType === null
      ) {
        return [];
      }
      return [{ type: lineType, text }];
    });
    return [{ header, lines }];
  });
}

/**
 * Read the durable change record embedded in one successful tool message.
 * The message owns this evidence; no current Git state is consulted.
 */
export function reviewChangeFromMessage(message: UiMessage): ReviewChange | null {
  if (
    message.role !== "tool" ||
    message.toolStatus !== "success" ||
    !REVIEW_CHANGE_TOOLS.has(normalizeToolName(message.toolName ?? ""))
  ) {
    return null;
  }

  const details = toolResultDetails(message);
  if (details?.root !== "workspace") return null;
  const review = recordValue(details.review);
  if (!review || review.version !== 1) return null;

  const snapshotId = nonEmptyString(review.snapshotId);
  const messageId = nonEmptyString(review.messageId);
  const path = nonEmptyString(review.path);
  const operation = review.operation;
  const status = review.status;
  const state = review.state;
  const additions = nonNegativeInteger(review.additions);
  const deletions = nonNegativeInteger(review.deletions);
  if (
    !snapshotId ||
    !messageId ||
    !path ||
    typeof operation !== "string" ||
    !REVIEW_CHANGE_OPERATIONS.has(operation) ||
    typeof status !== "string" ||
    !REVIEW_CHANGE_STATUSES.has(status as ReviewChangeStatus) ||
    typeof state !== "string" ||
    !REVIEW_CHANGE_STATES.has(state as ReviewChangeState) ||
    additions === null ||
    deletions === null
  ) {
    return null;
  }

  return {
    version: 1,
    snapshotId,
    messageId,
    path,
    operation: operation as ReviewChange["operation"],
    status: status as ReviewChangeStatus,
    state: state as ReviewChangeState,
    additions,
    deletions,
    hunks: parseHunks(review.hunks),
    ...(review.binary === true ? { binary: true } : {}),
    ...(review.truncated === true ? { truncated: true } : {}),
    reversible: review.reversible === true,
  };
}

export function reviewChangesFromMessages(
  messages: UiMessage[],
): ReviewChangeEntry[] {
  return messages.flatMap((message) => {
    const change = reviewChangeFromMessage(message);
    return change ? [{ message, change }] : [];
  });
}

export function summarizeReviewChanges(
  changes: ReviewChangeEntry[] | ReviewChange[],
): ReviewChangesSummary {
  return changes.reduce<ReviewChangesSummary>(
    (summary, entry) => {
      const change = "change" in entry ? entry.change : entry;
      summary.changeCount += 1;
      summary.additions += change.additions;
      summary.deletions += change.deletions;
      if (change.state === "rolledBack") summary.rolledBackCount += 1;
      else summary.activeCount += 1;
      return summary;
    },
    {
      changeCount: 0,
      activeCount: 0,
      rolledBackCount: 0,
      additions: 0,
      deletions: 0,
    },
  );
}

/** Update only the persisted message-local review state after a rollback. */
export function withReviewChangeState(
  message: UiMessage,
  state: ReviewChangeState,
): UiMessage {
  const toolResult = recordValue(message.toolResult);
  const details = recordValue(toolResult?.details);
  const review = recordValue(details?.review);
  if (!toolResult || !details || !review) return message;
  return {
    ...message,
    toolResult: {
      ...toolResult,
      details: {
        ...details,
        review: {
          ...review,
          state,
        },
      },
    },
  };
}
