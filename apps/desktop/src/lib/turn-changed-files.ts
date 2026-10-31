import type { ReviewChangeStatus, UiMessage } from "@pi-desktop/shared";
import { reviewChangeFromMessage } from "./workspace-review.ts";

/** Rows shown before the per-turn summary folds the rest into `+N more`. */
export const TURN_CHANGES_VISIBLE_LIMIT = 12;
/** Above this many files the summary switches to its dense row metrics. */
export const TURN_CHANGES_RELAXED_LIMIT = 4;

/** One workspace file touched by a turn, merged across all of its edits. */
export type TurnChangedFile = {
  path: string;
  status: ReviewChangeStatus;
  additions: number;
  deletions: number;
  /** Every recorded change of this file in the turn was rolled back. */
  rolledBack: boolean;
  /** The turn's snapshots for this file, in chronological order. */
  snapshotIds: string[];
};

export type TurnChangesSummary = {
  files: TurnChangedFile[];
  directoryCount: number;
  additions: number;
  deletions: number;
};

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

/**
 * Aggregate the message-owned review records of one turn's tool messages by
 * path. Counts add up across edits; a file the turn ends by deleting is `D`,
 * otherwise any creation makes it `A`, and everything else is `M`.
 */
export function summarizeTurnChanges(tools: readonly UiMessage[]): TurnChangesSummary {
  const byPath = new Map<string, TurnChangedFile>();
  const created = new Set<string>();
  for (const message of tools) {
    const change = reviewChangeFromMessage(message);
    if (!change) continue;
    const rolledBack = change.state === "rolledBack";
    if (change.status === "added") created.add(change.path);
    const existing = byPath.get(change.path);
    if (!existing) {
      byPath.set(change.path, {
        path: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        rolledBack,
        snapshotIds: [change.snapshotId],
      });
      continue;
    }
    existing.additions += change.additions;
    existing.deletions += change.deletions;
    existing.rolledBack &&= rolledBack;
    existing.snapshotIds.push(change.snapshotId);
    existing.status = change.status === "deleted"
      ? "deleted"
      : created.has(change.path) ? "added" : "modified";
  }
  const files = [...byPath.values()];
  return {
    files,
    directoryCount: new Set(files.map((file) => directoryOf(file.path))).size,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}
