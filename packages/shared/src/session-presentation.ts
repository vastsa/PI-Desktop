import type { SessionSummary } from "./types/sessions.js";

export type SessionSort = "recent" | "created" | "oldest" | "name" | "manual";
export type SessionPresentationMeta = {
  pinned?: boolean;
  archived?: boolean;
  order?: number;
};

export function sessionIsPinned(id: string, meta: Record<string, SessionPresentationMeta>): boolean {
  return meta[id]?.pinned === true;
}
export function sessionIsArchived(id: string, meta: Record<string, SessionPresentationMeta>): boolean {
  return meta[id]?.archived === true;
}

function manualOrder(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortSessions(
  sessions: SessionSummary[],
  meta: Record<string, SessionPresentationMeta>,
  sort: SessionSort = "recent",
  includeArchived = false,
): SessionSummary[] {
  const rows = includeArchived
    ? sessions
    : sessions.filter((session) => !sessionIsArchived(session.id, meta));
  return [...rows].sort((a, b) => {
    const archived = Number(sessionIsArchived(a.id, meta)) - Number(sessionIsArchived(b.id, meta));
    if (archived) return archived;
    const pinned = Number(sessionIsPinned(b.id, meta)) - Number(sessionIsPinned(a.id, meta));
    if (pinned) return pinned;
    if (sort === "name") {
      const byName = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      if (byName) return byName;
    } else if (sort === "created") {
      const byCreated = compareOptionalNumber(
        timestamp(a.createdAt) || undefined,
        timestamp(b.createdAt) || undefined,
        true,
      );
      if (byCreated) return byCreated;
    } else if (sort === "oldest") {
      const byCreated = compareOptionalNumber(
        timestamp(a.createdAt) || undefined,
        timestamp(b.createdAt) || undefined,
        false,
      );
      if (byCreated) return byCreated;
    } else if (sort === "manual") {
      const byOrder = (manualOrder(meta[a.id]?.order) ?? Number.MAX_SAFE_INTEGER) -
        (manualOrder(meta[b.id]?.order) ?? Number.MAX_SAFE_INTEGER);
      if (byOrder) return byOrder;
    } else {
      const byUpdated = compareOptionalNumber(
        timestamp(a.updatedAt) || undefined,
        timestamp(b.updatedAt) || undefined,
        true,
      );
      if (byUpdated) return byUpdated;
    }
    return compareOptionalNumber(
      timestamp(a.updatedAt) || undefined,
      timestamp(b.updatedAt) || undefined,
      true,
    ) || a.id.localeCompare(b.id);
  });
}

function compareOptionalNumber(
  a: number | undefined,
  b: number | undefined,
  descending: boolean,
): number {
  const hasA = typeof a === "number" && Number.isFinite(a);
  const hasB = typeof b === "number" && Number.isFinite(b);
  if (!hasA && !hasB) return 0;
  if (!hasA) return 1;
  if (!hasB) return -1;
  return descending ? (b as number) - (a as number) : (a as number) - (b as number);
}
