import type { SessionSummary } from "@pi-desktop/shared";
import type { ProjectSort } from "./sidebar-preferences";

/**
 * One sidebar project group, flattened to the fields that decide its order.
 *
 * Local project groups and host-owned remote groups both sort through this, so
 * a remote group cannot drift up or down the list just because its sessions
 * arrived in a different array order from the host.
 */
export type ProjectOrderInput = {
  /** Stable identity; the last tie-break, so equal groups never swap places. */
  key: string;
  name: string;
  sessions: readonly Pick<SessionSummary, "createdAt" | "updatedAt">[];
  archived?: boolean;
  pinned?: boolean;
  /** Manual position. Only consulted for the `manual` sort. */
  manualOrder?: number | null;
};

function timestamp(value?: string): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstSessionDate(
  sessions: ProjectOrderInput["sessions"],
  field: "createdAt" | "updatedAt",
): number | null {
  const values = sessions
    .map((session) => timestamp(session[field]))
    .filter((value) => value > 0);
  return values.length ? Math.min(...values) : null;
}

function lastSessionDate(
  sessions: ProjectOrderInput["sessions"],
  field: "createdAt" | "updatedAt",
): number | null {
  const values = sessions
    .map((session) => timestamp(session[field]))
    .filter((value) => value > 0);
  return values.length ? Math.max(...values) : null;
}

function compareOptionalDate(
  a: number | null,
  b: number | null,
  descending: boolean,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

/**
 * Sidebar project order for a given sort mode.
 *
 * Pinned and archived buckets lead regardless of mode, `manual` reads the
 * stored position, `name` compares labels, `created` / `oldest` read the
 * project's own session dates, and `recent` keeps the most recently active
 * project on top.
 */
export function compareProjectGroups(
  a: ProjectOrderInput,
  b: ProjectOrderInput,
  sort: ProjectSort,
): number {
  const archiveOrder = Number(!!a.archived) - Number(!!b.archived);
  if (archiveOrder !== 0) return archiveOrder;
  const pinOrder = Number(!!b.pinned) - Number(!!a.pinned);
  if (pinOrder !== 0) return pinOrder;
  if (sort === "manual") {
    const byOrder =
      (a.manualOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.manualOrder ?? Number.MAX_SAFE_INTEGER);
    if (byOrder !== 0) return byOrder;
  } else if (sort === "name") {
    const byName = a.name.localeCompare(b.name, undefined, {
      sensitivity: "base",
    });
    if (byName !== 0) return byName;
  } else if (sort === "oldest" || sort === "created") {
    const dateForProject =
      sort === "oldest" ? firstSessionDate : lastSessionDate;
    const byCreated = compareOptionalDate(
      dateForProject(a.sessions, "createdAt"),
      dateForProject(b.sessions, "createdAt"),
      sort === "created",
    );
    if (byCreated !== 0) return byCreated;
  } else {
    const byRecent = compareOptionalDate(
      lastSessionDate(a.sessions, "updatedAt"),
      lastSessionDate(b.sessions, "updatedAt"),
      true,
    );
    if (byRecent !== 0) return byRecent;
  }
  return a.key.localeCompare(b.key);
}
