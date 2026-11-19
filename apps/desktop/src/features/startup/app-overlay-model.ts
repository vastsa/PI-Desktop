/**
 * Pure rules for the app-level modal overlays: the startup guide, the release
 * announcement and the Settings dialog. Only one is on screen at a time, in
 * the fixed priority guide > announcement > settings; a lower one waits until
 * every higher one is gone.
 */

export type AppOverlay = "guide" | "announcement" | "settings";

export function resolveAppOverlay(pending: {
  guide: boolean;
  announcement: boolean;
  settings: boolean;
}): AppOverlay | null {
  if (pending.guide) return "guide";
  if (pending.announcement) return "announcement";
  if (pending.settings) return "settings";
  return null;
}

// ---------------------------------------------------------------------------
// Startup guide

/** Bump to show the guide again to everyone after it gains new steps. */
export const STARTUP_GUIDE_VERSION = 1;

export type StartupGuideStep = "model" | "launcher";

export type StartupGuidePlan = {
  /** New users have no usable chat model yet; returning users already do. */
  audience: "new" | "returning";
  steps: readonly StartupGuideStep[];
};

/**
 * The guide for the user's current state: users who have not configured a
 * usable model yet get the (skippable) model step first.
 */
export function startupGuideFor(hasUsableModel: boolean): StartupGuidePlan {
  return hasUsableModel
    ? { audience: "returning", steps: ["launcher"] }
    : { audience: "new", steps: ["model", "launcher"] };
}

/**
 * The guide a launch shows automatically, or null once this guide version was
 * finished or skipped. Decided once per launch: configuring a model during
 * the guide must not switch the audience underneath the user.
 */
export function planStartupGuide(input: {
  completedVersion: number;
  hasUsableModel: boolean;
}): StartupGuidePlan | null {
  if (input.completedVersion >= STARTUP_GUIDE_VERSION) return null;
  return startupGuideFor(input.hasUsableModel);
}

// ---------------------------------------------------------------------------
// Release announcement

/** The announcement a release ships (see features/startup/announcements). */
export type AnnouncementSchedule = {
  /**
   * The release version it belongs to, e.g. `0.24.0`; also the content folder
   * name. Each id is shown at most once.
   */
  id: string;
};

/** Announcement ids this renderer has already shown. */
export type AnnouncementRecord = {
  shownIds: readonly string[];
};

/** Most recent ids kept; older releases can never be shipped again anyway. */
const ANNOUNCEMENT_HISTORY_LIMIT = 20;

/** Show a release's announcement once; closing it retires it for good. */
export function shouldShowAnnouncement(
  schedule: AnnouncementSchedule | null,
  record: AnnouncementRecord,
): boolean {
  return schedule !== null && !record.shownIds.includes(schedule.id);
}

export function announcementShown(
  schedule: AnnouncementSchedule,
  record: AnnouncementRecord,
): AnnouncementRecord {
  if (record.shownIds.includes(schedule.id)) return record;
  return {
    shownIds: [...record.shownIds, schedule.id].slice(-ANNOUNCEMENT_HISTORY_LIMIT),
  };
}

/**
 * Content locale candidates, most specific first: `zh-TW` → `zh-TW`, `zh`,
 * then English as the release baseline.
 */
export function announcementLocaleCandidates(language: string | undefined): string[] {
  const candidates: string[] = [];
  const push = (value: string) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  if (language) {
    push(language);
    push(language.split("-")[0] ?? "");
  }
  push("en");
  return candidates;
}
