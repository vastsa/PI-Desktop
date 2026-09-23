import type { AssistantTurnEntry } from "./assistant-turns";
import {
  reviewCaptureFromMessage,
  reviewChangesMetadataFromMessage,
  type ReviewChangeMetadataEntry,
} from "./workspace-review";

export type TurnFileGroup = {
  path: string;
  entries: ReviewChangeMetadataEntry[];
  activeOperationCount: number;
  rolledBackOperationCount: number;
  additions: number;
  deletions: number;
};

export type TurnFileSummaryData = {
  files: TurnFileGroup[];
  fileCount: number;
  operationCount: number;
  activeOperationCount: number;
  rolledBackOperationCount: number;
  additions: number;
  deletions: number;
  hasBashTool: boolean;
  hasCompleteCapture: boolean;
  hasPartialCapture: boolean;
  hasUnavailableCapture: boolean;
};

type IndexedReviewChange = ReviewChangeMetadataEntry & { index: number };


/** Project durable workspace evidence owned by one visual assistant turn. */
export function summarizeTurnFileChanges(
  entry: AssistantTurnEntry,
): TurnFileSummaryData {
  const tools = entry.ownedToolMessages;
  const latestBySnapshot = new Map<string, IndexedReviewChange>();
  let sequence = 0;

  for (const message of tools) {
    for (const change of reviewChangesMetadataFromMessage(message)) {
      latestBySnapshot.set(change.snapshotId, {
        message,
        change,
        index: sequence,
      });
      sequence += 1;
    }
  }

  const operations = [...latestBySnapshot.values()].sort(
    (left, right) => right.index - left.index,
  );
  const filesByPath = new Map<string, TurnFileGroup>();

  for (const operation of operations) {
    let file = filesByPath.get(operation.change.path);
    if (!file) {
      file = {
        path: operation.change.path,
        entries: [],
        activeOperationCount: 0,
        rolledBackOperationCount: 0,
        additions: 0,
        deletions: 0,
      };
      filesByPath.set(operation.change.path, file);
    }
    file.entries.push({ message: operation.message, change: operation.change });
    if (operation.change.state === "rolledBack") {
      file.rolledBackOperationCount += 1;
    } else {
      file.activeOperationCount += 1;
      file.additions += operation.change.additions;
      file.deletions += operation.change.deletions;
    }
  }

  const captures = tools
    .map(reviewCaptureFromMessage)
    .filter((status) => status !== null);
  const files = [...filesByPath.values()];
  return files.reduce<TurnFileSummaryData>(
    (summary, file) => {
      summary.files.push(file);
      summary.fileCount += 1;
      summary.operationCount += file.entries.length;
      summary.activeOperationCount += file.activeOperationCount;
      summary.rolledBackOperationCount += file.rolledBackOperationCount;
      summary.additions += file.additions;
      summary.deletions += file.deletions;
      return summary;
    },
    {
      files: [],
      fileCount: 0,
      operationCount: 0,
      activeOperationCount: 0,
      rolledBackOperationCount: 0,
      additions: 0,
      deletions: 0,
      hasBashTool: captures.length > 0,
      hasCompleteCapture: captures.includes("complete"),
      hasPartialCapture: captures.includes("partial"),
      hasUnavailableCapture: captures.includes("unavailable"),
    },
  );
}
