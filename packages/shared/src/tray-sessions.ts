import { normalizeProjectPath } from "./activation.js";
import { latestSessionOutcomes } from "./session-outcomes.js";
import {
  sortSessions,
  type SessionPresentationMeta,
  type SessionSort,
} from "./session-presentation.js";
import type { SessionSummary } from "./types/sessions.js";
import type { AppNotification } from "./types/workspace.js";

/** Rows every non-empty group keeps for itself before spare capacity is shared. */
export const TRAY_SESSION_GROUP_SHARE = 3;
/** Rows the menu may show across all groups once unused shares are reclaimed. */
export const TRAY_SESSION_TOTAL_LIMIT = 9;
export const TRAY_SESSION_TITLE_LIMIT = 48;
export const TRAY_SESSION_GROUPS = ["running", "unread", "pinned"] as const;
export type TraySessionGroupKind = (typeof TRAY_SESSION_GROUPS)[number];

/** An ephemeral copy of renderer-owned organization; never persisted by Main. */
export type TraySessionPreferences = {
  sessionMeta: Record<string, SessionPresentationMeta>;
  archivedProjectPaths: string[];
  sort: SessionSort;
};

export type TraySessionGroup = {
  kind: TraySessionGroupKind;
  sessions: Pick<SessionSummary, "id" | "title">[];
  hasMore: boolean;
};

export function parseTraySessionPreferences(input: unknown): TraySessionPreferences | null {
  if (!input || typeof input !== "object") return null;
  const { sessionMeta, archivedProjectPaths, sort } = input as TraySessionPreferences;
  if (!sessionMeta || typeof sessionMeta !== "object" || Array.isArray(sessionMeta)) return null;
  if (
    !Array.isArray(archivedProjectPaths) ||
    !archivedProjectPaths.every((path) => typeof path === "string")
  ) return null;
  if (!["recent", "created", "oldest", "name", "manual"].includes(sort)) return null;
  const cleanedMeta: Record<string, SessionPresentationMeta> = Object.create(null);
  for (const [id, entry] of Object.entries(sessionMeta)) {
    if (!id || !entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { pinned, archived, order } = entry;
    if (pinned !== undefined && typeof pinned !== "boolean") return null;
    if (archived !== undefined && typeof archived !== "boolean") return null;
    if (order !== undefined && (!Number.isSafeInteger(order) || order < 0)) return null;
    cleanedMeta[id] = { pinned, archived, order };
  }
  return {
    sessionMeta: cleanedMeta,
    archivedProjectPaths: archivedProjectPaths.map(normalizeProjectPath),
    sort,
  };
}

export function traySessionTitle(title: string, fallback: string): string {
  const singleLine = title
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(singleLine || fallback);
  return characters.length > TRAY_SESSION_TITLE_LIMIT
    ? `${characters.slice(0, TRAY_SESSION_TITLE_LIMIT - 1).join("")}…`
    : characters.join("");
}

/**
 * Every non-empty group keeps its own share first, so a busy higher-priority
 * group can never crowd a lower one out of the menu entirely. Whatever share
 * the smaller groups leave unused is handed to the groups that still overflow,
 * in priority order, until the total row budget runs out.
 *
 * Both passes draw from the same budget, so the result stays within
 * `TRAY_SESSION_TOTAL_LIMIT` even if the group list outgrows what the
 * per-group share would divide into.
 */
export function allocateTraySessionRows(counts: readonly number[]): number[] {
  let budget = TRAY_SESSION_TOTAL_LIMIT;
  const limits = counts.map((count) => {
    const share = Math.min(count, TRAY_SESSION_GROUP_SHARE, budget);
    budget -= share;
    return share;
  });
  for (let index = 0; index < limits.length && budget > 0; index += 1) {
    const extra = Math.min(counts[index] - limits[index], budget);
    limits[index] += extra;
    budget -= extra;
  }
  return limits;
}

export function buildTraySessionGroups(
  sessions: SessionSummary[],
  running: ReadonlySet<string>,
  notifications: AppNotification[],
  preferences: TraySessionPreferences,
): TraySessionGroup[] {
  const archivedProjects = new Set(preferences.archivedProjectPaths);
  const outcomes = latestSessionOutcomes(notifications);
  const unreadOrder = new Map<string, number>();
  notifications.forEach((notification, index) => {
    if (!unreadOrder.has(notification.sessionId)) unreadOrder.set(notification.sessionId, index);
  });
  const groups: Record<TraySessionGroupKind, SessionSummary[]> = {
    running: [], unread: [], pinned: [],
  };
  const seen = new Set<string>();
  for (const session of sortSessions(sessions, preferences.sessionMeta, preferences.sort)) {
    if (seen.has(session.id) || archivedProjects.has(normalizeProjectPath(session.projectPath))) continue;
    seen.add(session.id);
    // Assign before truncating, so overflow from Running cannot leak into Unread/Pinned.
    if (running.has(session.id)) groups.running.push(session);
    else if (outcomes[session.id]) groups.unread.push(session);
    else if (preferences.sessionMeta[session.id]?.pinned) groups.pinned.push(session);
  }
  groups.unread.sort((a, b) => unreadOrder.get(a.id)! - unreadOrder.get(b.id)!);
  const limits = allocateTraySessionRows(TRAY_SESSION_GROUPS.map((kind) => groups[kind].length));
  return TRAY_SESSION_GROUPS.flatMap((kind, index) => {
    const rows = groups[kind];
    const limit = limits[index];
    // Hide a group with no rows to show, whether it is empty or the budget ran
    // out before it: a heading whose only entry is View more is not a group.
    if (limit === 0) return [];
    return [{
      kind,
      sessions: rows.slice(0, limit).map(({ id, title }) => ({ id, title })),
      hasMore: rows.length > limit,
    }];
  });
}
