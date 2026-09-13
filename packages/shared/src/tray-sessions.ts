import { normalizeProjectPath } from "./activation.js";
import { latestSessionOutcomes } from "./session-outcomes.js";
import {
  sortSessions,
  type SessionPresentationMeta,
  type SessionSort,
} from "./session-presentation.js";
import type { SessionSummary } from "./types/sessions.js";
import type { AppNotification } from "./types/workspace.js";

export const TRAY_SESSION_LIMIT = 3;
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
  return TRAY_SESSION_GROUPS.filter((kind) => groups[kind].length > 0).map((kind) => ({
    kind,
    sessions: groups[kind].slice(0, TRAY_SESSION_LIMIT).map(({ id, title }) => ({ id, title })),
    hasMore: groups[kind].length > TRAY_SESSION_LIMIT,
  }));
}
