import type {
  DiffHunk,
  ReviewChange,
  ReviewChangeState,
  ReviewChangeStatus,
  UiMessage,
} from "@pi-desktop/shared";

const LEGACY_REVIEW_CHANGE_TOOLS = new Set(["Write", "Edit"]);
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
const REVIEW_CAPTURE_STATUSES = new Set<ReviewCaptureStatus>([
  "complete",
  "partial",
  "unavailable",
]);

export type ReviewCaptureStatus = "complete" | "partial" | "unavailable";

export type ReviewChangeMetadata = Omit<ReviewChange, "hunks">;

export type ReviewChangeEntry = {
  message: UiMessage;
  change: ReviewChange;
};

export type ReviewChangeMetadataEntry = {
  message: UiMessage;
  change: ReviewChangeMetadata;
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

function isExecutedReviewTool(message: UiMessage): boolean {
  if (message.role !== "tool") return false;
  if (LEGACY_REVIEW_CHANGE_TOOLS.has(message.toolName || "")) {
    return message.toolStatus === "success";
  }
  return (
    message.toolName === "Bash" &&
    (message.toolStatus === "success" || message.toolStatus === "error")
  );
}

/** Shell build caches are incidental evidence, not user-authored workspace edits. */
export function isIncidentalShellCacheReview(
  message: UiMessage,
  path: string,
): boolean {
  if (message.toolName !== "Bash") return false;
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments.slice(0, -1).some((segment) => segment === ".gradle");
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
      return text === null || lineType === null ? [] : [{ type: lineType, text }];
    });
    return [{ header, lines }];
  });
}

function parseReviewChangeMetadata(value: unknown): ReviewChangeMetadata | null {
  const review = recordValue(value);
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
    ...(review.binary === true ? { binary: true } : {}),
    ...(review.truncated === true ? { truncated: true } : {}),
    reversible: review.reversible === true,
  };
}

function parseReviewChange(value: unknown): ReviewChange | null {
  const metadata = parseReviewChangeMetadata(value);
  if (!metadata) return null;
  return {
    ...metadata,
    hunks: parseHunks(recordValue(value)?.hunks),
  };
}

function reviewRecordsFromMessage<T extends { path: string }>(
  message: UiMessage,
  parse: (value: unknown) => T | null,
  snapshotIdOf: (item: T) => string,
): T[] {
  if (!isExecutedReviewTool(message)) return [];
  const details = toolResultDetails(message);
  if (details?.root !== "workspace") return [];

  const candidates = [
    ...(details.review === undefined ? [] : [details.review]),
    ...(Array.isArray(details.reviews) ? details.reviews : []),
  ];
  const changes = new Map<string, T>();
  for (const candidate of candidates) {
    const change = parse(candidate);
    if (change && !isIncidentalShellCacheReview(message, change.path)) {
      changes.set(snapshotIdOf(change), change);
    }
  }
  return [...changes.values()];
}

/** Read every independently valid durable change record owned by one message. */
export function reviewChangesFromMessage(message: UiMessage): ReviewChange[] {
  return reviewRecordsFromMessage(
    message,
    parseReviewChange,
    (change) => change.snapshotId,
  );
}

/** Same admission as full review parse, without walking diff hunks. */
export function reviewChangesMetadataFromMessage(
  message: UiMessage,
): ReviewChangeMetadata[] {
  return reviewRecordsFromMessage(
    message,
    parseReviewChangeMetadata,
    (change) => change.snapshotId,
  );
}

/** Compatibility wrapper for callers that still expect one review per message. */
export function reviewChangeFromMessage(message: UiMessage): ReviewChange | null {
  return reviewChangesFromMessage(message)[0] ?? null;
}

/**
 * Shell capture scope is separate from its change list: complete with no
 * reviews means a tracked read-only/no-op command, while missing legacy
 * metadata cannot make that claim.
 */
export function reviewCaptureFromMessage(
  message: UiMessage,
): ReviewCaptureStatus | null {
  if (
    message.role !== "tool" ||
    message.toolName !== "Bash" ||
    (message.toolStatus !== "success" && message.toolStatus !== "error")
  ) {
    return null;
  }
  const details = toolResultDetails(message);
  if (details?.root === "scratch") return null;
  if (details?.root !== undefined && details.root !== "workspace") return null;
  const capture = recordValue(details?.reviewCapture);
  const status = capture?.status;
  return typeof status === "string" &&
    REVIEW_CAPTURE_STATUSES.has(status as ReviewCaptureStatus)
    ? (status as ReviewCaptureStatus)
    : "unavailable";
}

export function reviewChangesFromMessages(
  messages: UiMessage[],
): ReviewChangeEntry[] {
  const latestBySnapshot = new Map<
    string,
    ReviewChangeEntry & { sequence: number }
  >();
  let sequence = 0;
  for (const message of messages) {
    for (const change of reviewChangesFromMessage(message)) {
      latestBySnapshot.set(change.snapshotId, { message, change, sequence });
      sequence += 1;
    }
  }
  return [...latestBySnapshot.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .map(({ message, change }) => ({ message, change }));
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

/** Update only the matching persisted message-local review after a rollback. */
export function withReviewChangeState(
  message: UiMessage,
  state: ReviewChangeState,
  snapshotId?: string,
): UiMessage {
  const toolResult = recordValue(message.toolResult);
  const details = recordValue(toolResult?.details);
  if (!toolResult || !details) return message;
  const targetSnapshotId = snapshotId ?? reviewChangeFromMessage(message)?.snapshotId;
  if (!targetSnapshotId) return message;

  let changed = false;
  const update = (value: unknown): unknown => {
    const review = recordValue(value);
    if (review?.snapshotId !== targetSnapshotId) return value;
    changed = true;
    return { ...review, state };
  };
  const review = update(details.review);
  const reviews = Array.isArray(details.reviews)
    ? details.reviews.map(update)
    : details.reviews;
  if (!changed) return message;

  return {
    ...message,
    toolResult: {
      ...toolResult,
      details: {
        ...details,
        ...(details.review !== undefined ? { review } : {}),
        ...(details.reviews !== undefined ? { reviews } : {}),
      },
    },
  };
}
