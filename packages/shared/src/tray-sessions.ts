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
/** Display columns one tray row may use, ellipsis included. */
export const TRAY_SESSION_TITLE_COLUMNS = 32;
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

/**
 * East Asian wide and fullwidth code points, plus everything Unicode gives
 * emoji presentation by default, draw at two display columns. Counting them as
 * two keeps a CJK menu row as wide as a Latin one instead of letting one
 * Chinese title fill the whole tray menu.
 */
const WIDE_CODE_POINT =
  /[\u1100-\u115f\u2329-\u232a\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1b000}\u{1b001}\u{1f000}-\u{1faff}\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;
/** Joiners, zero-width space, variation selectors, and combining marks draw nothing of their own. */
const ZERO_WIDTH_CODE_POINT = /[\u200b-\u200d\u2060\ufe00-\ufe0f]|\p{Mn}/u;
/** A text-presentation base becomes a two-column emoji once this selector follows it. */
const EMOJI_VARIATION_SELECTOR = "\ufe0f";
/** Joiners and zero-width code points that the cut left with nothing to join. */
const DANGLING_TAIL = /[\u200b-\u200d\u2060]+$/u;

/** Display columns one code point of `characters` occupies in a native menu row. */
function characterColumns(characters: readonly string[], index: number): number {
  const character = characters[index];
  if (ZERO_WIDTH_CODE_POINT.test(character)) return 0;
  if (characters[index + 1] === EMOJI_VARIATION_SELECTOR) return 2;
  return WIDE_CODE_POINT.test(character) ? 2 : 1;
}

function titleColumns(characters: readonly string[]): number {
  let columns = 0;
  for (let index = 0; index < characters.length; index += 1) {
    columns += characterColumns(characters, index);
  }
  return columns;
}

/**
 * One line that never outgrows `TRAY_SESSION_TITLE_COLUMNS`: a longer title is
 * cut to `TRAY_SESSION_TITLE_COLUMNS - 1` columns plus an ellipsis, so Latin,
 * CJK, and emoji rows land at the same menu width.
 */
export function traySessionTitle(title: string, fallback: string): string {
  const singleLine = title
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const line = singleLine || fallback;
  const characters = Array.from(line);
  if (titleColumns(characters) <= TRAY_SESSION_TITLE_COLUMNS) return line;
  const budget = TRAY_SESSION_TITLE_COLUMNS - 1;
  let clipped = "";
  let columns = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const next = columns + characterColumns(characters, index);
    if (next > budget) break;
    clipped += characters[index];
    columns = next;
  }
  return `${clipped.replace(DANGLING_TAIL, "").trimEnd()}\u2026`;
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
