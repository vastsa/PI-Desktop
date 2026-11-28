import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadStyles } from "./helpers/styles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { hiddenUnreadState, scheduledUnread } = await import("../src/lib/sidebar-unread.ts");
const { getVisibleProjectSessions } = await import("../src/lib/sidebar-project-sessions.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const sidebarSource = await read("../src/components/Sidebar.tsx");
const navSource = await read("../src/components/SidebarNavigation.tsx");
const runHistorySource = await read("../src/features/scheduled/ScheduledRunHistory.tsx");
const taskDetailSource = await read("../src/features/scheduled/ScheduledTaskDetail.tsx");
const scheduledPageSource = await read("../src/pages/ScheduledPage.tsx");
const styles = await loadStyles();
// The scheduled workspace owns its own partial; globals.css does not import it.
const scheduledStyles = await read("../src/features/scheduled/scheduled-workspace.css");

const LOCALES = ["de", "en", "es", "fr", "ko", "pt-BR", "tr", "zh-CN", "zh-TW"];

/** A session row as the group renders it; only the id matters to the count. */
const session = (id, extra = {}) => ({ id, ...extra });

/** Newest-first notification row, exactly as the host lists them. */
const notification = (sessionId, kind, createdAt, extra = {}) => ({
  id: `${sessionId}:${createdAt}`,
  kind,
  sessionId,
  sessionTitle: sessionId,
  turnId: "turn-1",
  createdAt,
  ...extra,
});

/** The project group's non-pinned history, folded at the sidebar's page size. */
const foldedProject = (count) => {
  const history = Array.from({ length: count }, (_, index) => session(`s${index}`));
  const { visibleSessions, hiddenCount } = getVisibleProjectSessions(history, false);
  return { history, visible: visibleSessions, hiddenCount };
};

test("an unread-free fold earns no project indicator", () => {
  const history = [session("a"), session("b")];
  const { visibleSessions } = getVisibleProjectSessions(history, false);

  assert.equal(hiddenUnreadState(history.slice(visibleSessions.length), {}), null);
  assert.equal(
    hiddenUnreadState(history.slice(visibleSessions.length), { b: "completed" }),
    null,
    "a visible row's outcome is already on its own row",
  );
});

test("a folded failure marks the whole project", () => {
  const { history, visible, hiddenCount } = foldedProject(12);
  assert.ok(hiddenCount > 0, "the fixture must actually fold something");
  const hidden = history.slice(visible.length);

  assert.deepEqual(hiddenUnreadState(hidden, { [hidden[0].id]: "failed" }), {
    count: 1,
    failed: true,
  });
  assert.deepEqual(
    hiddenUnreadState(hidden, {
      [hidden[0].id]: "completed",
      [hidden[1].id]: "failed",
    }),
    { count: 2, failed: true },
    "one failure keeps the dot loud even next to finished work",
  );
});

test("a folded completion is counted but stays quiet", () => {
  const { history, visible } = foldedProject(12);
  const hidden = history.slice(visible.length);

  assert.deepEqual(hiddenUnreadState(hidden, { [hidden[hidden.length - 1].id]: "completed" }), {
    count: 1,
    failed: false,
  });
});

test("a collapsed group hides every non-pinned row, folded or not", () => {
  const { history, visible } = foldedProject(12);
  const collapsedProject = true;
  const hiddenSessions = collapsedProject ? history : history.slice(visible.length);

  assert.deepEqual(hiddenUnreadState(hiddenSessions, { s0: "failed" }), {
    count: 1,
    failed: true,
  });
  assert.equal(
    hiddenUnreadState(history.slice(visible.length), { s0: "failed" }),
    null,
    "an open group renders s0, so its outcome belongs to the row",
  );
});

test("pinned rows are outside the hidden set", () => {
  // Sidebar derives the group's history from the non-pinned sessions and keeps
  // pinned rows on screen, so only that history can be folded or collapsed.
  assert.match(
    sidebarSource,
    /const history = entry\.sessions\.filter\(\(session\) => !pinnedSessionIds\.has\(session\.id\)\);/,
  );
  assert.match(
    sidebarSource,
    /collapsedProject \? history : history\.slice\(visibleSessions\.length\)/,
  );

  // Same call the sidebar makes with the same data: the pinned row's outcome is
  // never part of the count.
  const pinned = session("pinned");
  const history = [session("visible"), session("folded")];
  assert.equal(hiddenUnreadState(history, { [pinned.id]: "failed" }), null);
});

test("the project indicator is announced, not just tinted", () => {
  assert.match(sidebarSource, /const hiddenUnread = hiddenUnreadState\(/);
  assert.match(sidebarSource, /t\("nav\.hiddenUnreadSessions", \{ count: hiddenUnread\.count \}\)/);
  assert.match(sidebarSource, /className=\{`sidebar-project-unread \$\{hiddenUnread\.failed \? "is-failed" : "is-completed"\}`\}/);
  assert.match(sidebarSource, /role="img"\s*\n\s*aria-label=\{hiddenUnreadLabel\}\s*\n\s*title=\{hiddenUnreadLabel\}/);
  // The parent dot lives beside the title button: an `aria-label` inside a
  // button whose name is already fixed would never be announced.
  assert.match(
    sidebarSource,
    /<\/TooltipButton>\s*\{hiddenUnread \? \(\s*(?:\/\/[^\n]*\n\s*)*<span\s+className=\{`sidebar-project-unread /,
    "the dot is a sibling of the title button, not a child",
  );
  assert.match(styles, /\.sidebar-project-unread \{[\s\S]*?var\(--ds-success\)/);
  assert.match(styles, /\.sidebar-project-unread\.is-failed \{[\s\S]*?var\(--ds-error\)/);
});

test("scheduled runs keep only their own unread results", () => {
  const sessions = [
    session("run-1", { scheduledRun: true }),
    session("run-2", { scheduledRun: true }),
    session("chat-1", { scheduledRun: false }),
    session("chat-2"),
  ];
  const notifications = [
    notification("run-1", "task.completed", "2026-11-24T09:00:00.000Z"),
    notification("chat-1", "task.failed", "2026-11-24T08:00:00.000Z"),
    notification("run-2", "task.completed", "2026-11-24T07:00:00.000Z"),
    notification("chat-2", "task.completed", "2026-11-24T06:00:00.000Z"),
  ];

  const unread = scheduledUnread(sessions, notifications);
  assert.equal(unread.count, 2, "the app badge counts these two");
  assert.deepEqual([...unread.sessionIds].sort(), ["run-1", "run-2"]);
  assert.deepEqual(unread.outcomes, { "run-1": "completed", "run-2": "completed" });
});

test("scheduled unread reads the latest result per session and drops read ones", () => {
  const sessions = [session("run-1", { scheduledRun: true }), session("run-2", { scheduledRun: true })];
  const notifications = [
    // Newest first: a read result retires its session, and an older failure on
    // the same session is not a second unread result.
    notification("run-2", "task.completed", "2026-11-24T09:00:00.000Z", { readAt: "2026-11-24T09:05:00.000Z" }),
    notification("run-1", "task.completed", "2026-11-24T08:00:00.000Z"),
    notification("run-1", "task.failed", "2026-11-24T07:00:00.000Z"),
  ];

  const unread = scheduledUnread(sessions, notifications);
  assert.equal(unread.count, 1);
  assert.deepEqual([...unread.sessionIds], ["run-1"]);
  assert.deepEqual(unread.outcomes, { "run-1": "completed" });
});

test("a scheduled notification whose session row is not loaded is not counted", () => {
  const unread = scheduledUnread(
    [session("chat-1")],
    [notification("run-gone", "task.failed", "2026-11-24T09:00:00.000Z")],
  );
  assert.equal(unread.count, 0);
  assert.equal(unread.sessionIds.size, 0);
});

test("the Scheduled nav row carries the count only when the destination is shown", () => {
  assert.match(navSource, /const scheduledUnreadCount = useMemo\(/);
  assert.match(navSource, /showScheduled \? scheduledUnread\(sessions, notifications\)\.count : 0/);
  assert.match(navSource, /<span className="sidebar-primary-count" title=\{scheduledUnreadLabel\}>/);
  // The badge sits inside the `showScheduled` block, so it follows the same
  // `scheduledTasksEnabled && sidebarModuleVisible(modules, "scheduled")` gate.
  const scheduledBlock = navSource.slice(navSource.indexOf("{showScheduled && ("));
  assert.match(
    scheduledBlock.slice(0, scheduledBlock.indexOf("{showPluginMarket && (")),
    /sidebar-primary-count/,
  );
  assert.match(styles, /\.sidebar-primary-count \{[\s\S]*?border-radius: var\(--radius-full\)/);
});

test("run history marks an unread run with the same pale/red dot", () => {
  assert.match(runHistorySource, /unreadOutcomes = \{\}/);
  assert.match(runHistorySource, /const unread = sessionId \? unreadOutcomes\[sessionId\] : undefined;/);
  assert.match(
    runHistorySource,
    /className=\{cx\("scheduled-run-unread", unread === "failed" \? "is-failed" : "is-completed"\)\}/,
  );
  assert.match(runHistorySource, /aria-label=\{unreadLabel\}/);
  // The page reads the same notification rows the badge does and threads the
  // per-session result down through the chosen task's page.
  assert.match(scheduledPageSource, /scheduledUnread\(sessions, notifications\)\.outcomes/);
  assert.match(scheduledPageSource, /unreadOutcomes=\{unreadOutcomes\}/);
  assert.match(taskDetailSource, /unreadOutcomes=\{unreadOutcomes\}/);
  assert.match(scheduledStyles, /\.scheduled-run-unread\.is-failed \{[\s\S]*?var\(--ds-error\)/);
});

test("opening a run reads its notifications, which is what clears the badge", () => {
  // ScheduledRunHistory.onOpenSession -> ScheduledPage.openSession -> the
  // session slice, which acknowledges the outcome before the chat is shown.
  const page = scheduledPageSource.slice(scheduledPageSource.indexOf("const openSession = async"));
  assert.match(page.slice(0, page.indexOf("const save = async")), /await selectSession\(sessionId\)/);

  return read("../src/stores/slices/session-slice.ts").then((slice) => {
    const selection = slice.slice(slice.indexOf("selectSession: async (id, opts) => {"));
    assert.match(
      selection.slice(0, selection.indexOf("const commitSelection")),
      /const outcomeAcknowledgement = get\(\)\.acknowledgeSessionOutcome\(id\);/,
    );
    return read("../src/stores/slices/catalog-slice.ts");
  }).then((catalog) => {
    const acknowledge = catalog.slice(catalog.indexOf("acknowledgeSessionOutcome: async (sessionId) =>"));
    const body = acknowledge.slice(0, acknowledge.indexOf("markAllNotificationsRead"));
    // The outcome badge clears locally and every unread notification row for
    // that session is marked read on the host.
    assert.match(body, /delete|withoutRecordKey/);
    assert.match(body, /await get\(\)\.markNotificationRead\(item\.id\)/);
    assert.match(catalog, /unreadNotificationCount: Math\.max\(\s*0,\s*state\.unreadNotificationCount - 1,/);
  });
});

test("every locale names both new indicators", async () => {
  for (const locale of LOCALES) {
    const catalog = await read(`../../../packages/i18n/src/locales/${locale}/index.ts`);
    for (const key of ["hiddenUnreadSessions", "scheduledUnread"]) {
      const entry = catalog.match(new RegExp(`"?${key}"?: "([^"]*)"`));
      assert.ok(entry, `${locale} ${key}`);
      assert.match(entry[1], /\{\{count\}\}/, `${locale} ${key} interpolates the count`);
    }
  }
});