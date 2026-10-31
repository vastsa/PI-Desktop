import type { DiffHunk, DiffLine, ReviewChangesPage, ReviewHistoryChange } from "@pi-desktop/shared";
import { reviewChangeFromMessage, type ReviewChangeEntry } from "./workspace-review.ts";

export type NumberedReviewLine = DiffLine & { oldLine: number | null; newLine: number | null };
export function numberedReviewHunks(hunks: readonly DiffHunk[]): { header: string; lines: NumberedReviewLine[] }[] {
  return hunks.map(hunk => {
    const coordinates = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
    let old = Number(coordinates?.[1]), next = Number(coordinates?.[2]);
    return { header: hunk.header, lines: hunk.lines.map(line => {
      const marker = line.text === "\\ No newline at end of file";
      const oldLine = coordinates && !marker && line.type !== "add" ? old++ : null;
      const newLine = coordinates && !marker && line.type !== "del" ? next++ : null;
      return { ...line, oldLine, newLine };
    }) };
  });
}

export type ReviewFileGroup = {
  id: string; path: string; root?: string; entries: ReviewChangeEntry[];
  additions: number; deletions: number;
};

/** Compact outside-root spellings for display only; keep snapshot paths intact. */
export function reviewFilePathLabel(path: string): string {
  const posix = path.replaceAll("\\", "/");
  let outside = posix.startsWith("/") || /^[a-z]:\//i.test(posix);
  let depth = 0;
  for (const segment of posix.split("/")) {
    if (segment === "..") { if (--depth < 0) outside = true; }
    else if (segment && segment !== ".") depth++;
  }
  return outside ? `.../${posix.split("/").filter(Boolean).at(-1) ?? path}` : path;
}

/** Presentation grouping only: never changes snapshot identity or operation order. */
export function groupReviewFiles(rows: readonly ReviewHistoryChange[]): ReviewFileGroup[] {
  const groups = new Map<string, ReviewFileGroup>(), seen = new Set<string>();
  for (const row of rows) {
    const change = reviewChangeFromMessage(row.message);
    if (!change || seen.has(change.snapshotId)) continue;
    seen.add(change.snapshotId);
    const root = row.root ?? change.root;
    // Missing legacy worktree provenance must not collapse into the parent root.
    const identity = root ?? (row.message.parentToolCallId ? `unknown:${row.message.parentToolCallId}` : "workspace");
    const id = JSON.stringify([identity, change.path]);
    let group = groups.get(id);
    if (!group) {
      group = { id, path: change.path, root, entries: [], additions: 0, deletions: 0 };
      groups.set(id, group);
    }
    group.entries.push({ message: row.message, change });
    group.additions += change.additions; group.deletions += change.deletions;
  }
  return [...groups.values()];
}

export type ReviewReadRequest = { sessionId: string; turnId?: string; snapshotId?: string; offset?: number; limit?: number };
export async function readReviewPages(
  read: (input: ReviewReadRequest) => Promise<ReviewChangesPage>,
  input: ReviewReadRequest,
  active: () => boolean,
): Promise<ReviewChangesPage> {
  let page = await read(input);
  const changes = [...page.changes];
  let offset = input.offset ?? 0;
  while (true) {
    if (!active()) throw new DOMException("Review selection changed", "AbortError");
    if (page.nextOffset === undefined) return { turnId: page.turnId, changes };
    if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error("Invalid review cursor");
    offset = page.nextOffset;
    page = await read({ sessionId: input.sessionId, turnId: page.turnId ?? undefined, offset, limit: input.limit });
    changes.push(...page.changes);
  }
}
