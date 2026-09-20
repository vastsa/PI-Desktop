import { describe, expect, it } from "vitest";
import {
  allocateTraySessionRows,
  buildTraySessionGroups,
  parseTraySessionPreferences,
  traySessionTitle,
  type TraySessionPreferences,
} from "./tray-sessions.js";
import type { SessionSummary } from "./types/sessions.js";
import type { AppNotification } from "./types/workspace.js";

function session(id: string): SessionSummary {
  return {
    id,
    title: id,
    messageCount: 1,
    mode: "agent",
    thinkingLevel: "off",
    permissionMode: "inherit",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

function sessions(prefix: string, count: number): SessionSummary[] {
  return Array.from({ length: count }, (_, index) => session(`${prefix}-${index}`));
}

function preferences(pinned: string[] = []): TraySessionPreferences {
  const sessionMeta = Object.fromEntries(pinned.map((id) => [id, { pinned: true }]));
  return { sessionMeta, archivedProjectPaths: [], sort: "recent" };
}

describe("allocateTraySessionRows", () => {
  it("gives a lone group the whole budget instead of only its own share", () => {
    expect(allocateTraySessionRows([7, 0, 0])).toEqual([7, 0, 0]);
    expect(allocateTraySessionRows([0, 7, 0])).toEqual([0, 7, 0]);
    expect(allocateTraySessionRows([0, 0, 7])).toEqual([0, 0, 7]);
  });

  it("caps the menu at the total budget", () => {
    expect(allocateTraySessionRows([12, 0, 0])).toEqual([9, 0, 0]);
    const total = allocateTraySessionRows([12, 8, 40]).reduce((sum, rows) => sum + rows, 0);
    expect(total).toBe(9);
  });

  it("holds the total even when the group list outgrows the per-group share", () => {
    // Four groups would claim 12 rows if each simply took its own share first.
    const limits = allocateTraySessionRows([5, 5, 5, 5]);
    expect(limits.reduce((sum, rows) => sum + rows, 0)).toBe(9);
    expect(limits).toEqual([3, 3, 3, 0]);
  });

  it("keeps every group's share when all of them overflow", () => {
    expect(allocateTraySessionRows([5, 4, 6])).toEqual([3, 3, 3]);
    expect(allocateTraySessionRows([40, 40, 40])).toEqual([3, 3, 3]);
  });

  it("hands spare share to overflowing groups in priority order", () => {
    // Running keeps 3, takes 2 more to clear its overflow; Pinned takes the last 1.
    expect(allocateTraySessionRows([5, 0, 6])).toEqual([5, 0, 4]);
    // A small Running group cannot consume share it has no rows for.
    expect(allocateTraySessionRows([2, 10, 0])).toEqual([2, 7, 0]);
  });

  it("never allocates more rows than a group actually has", () => {
    expect(allocateTraySessionRows([1, 1, 0])).toEqual([1, 1, 0]);
    expect(allocateTraySessionRows([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("never shows fewer rows than the per-group share alone would", () => {
    for (const counts of [[7, 0, 0], [5, 4, 6], [2, 10, 0], [4, 4, 0], [1, 0, 12]]) {
      const limits = allocateTraySessionRows(counts);
      counts.forEach((count, index) => expect(limits[index]).toBeGreaterThanOrEqual(Math.min(count, 3)));
    }
  });
});

describe("buildTraySessionGroups", () => {
  it("shows all seven running sessions when no other group claims share", () => {
    const running = sessions("run", 7);
    const groups = buildTraySessionGroups(running, new Set(running.map((s) => s.id)), [], preferences());
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("running");
    expect(groups[0].sessions).toHaveLength(7);
    expect(groups[0].hasMore).toBe(false);
  });

  it("marks overflow only once the total budget is exhausted", () => {
    const running = sessions("run", 12);
    const groups = buildTraySessionGroups(running, new Set(running.map((s) => s.id)), [], preferences());
    expect(groups[0].sessions).toHaveLength(9);
    expect(groups[0].hasMore).toBe(true);
  });

  it("reclaims the empty group's share across running and pinned", () => {
    const running = sessions("run", 4);
    const pinned = sessions("pin", 4);
    const groups = buildTraySessionGroups(
      [...running, ...pinned],
      new Set(running.map((s) => s.id)),
      [],
      preferences(pinned.map((s) => s.id)),
    );
    expect(groups.map((group) => [group.kind, group.sessions.length, group.hasMore])).toEqual([
      ["running", 4, false],
      ["pinned", 4, false],
    ]);
  });

  it("assigns unread after running and sorts newest unread first", () => {
    const running = session("run-0");
    const unreadNewer = session("unread-new");
    const unreadOlder = session("unread-old");
    const pinned = session("pin-0");
    const notifications: AppNotification[] = [
      {
        id: "n-new",
        kind: "task.completed",
        sessionId: unreadNewer.id,
        sessionTitle: unreadNewer.title,
        turnId: "t-new",
        createdAt: "2026-09-13T02:00:00.000Z",
      },
      {
        id: "n-old",
        kind: "task.failed",
        sessionId: unreadOlder.id,
        sessionTitle: unreadOlder.title,
        turnId: "t-old",
        createdAt: "2026-09-13T01:00:00.000Z",
      },
    ];
    const groups = buildTraySessionGroups(
      [pinned, unreadOlder, unreadNewer, running],
      new Set([running.id]),
      notifications,
      preferences([pinned.id, running.id]),
    );
    expect(groups.map((group) => [group.kind, group.sessions.map((row) => row.id)])).toEqual([
      ["running", ["run-0"]],
      ["unread", ["unread-new", "unread-old"]],
      ["pinned", ["pin-0"]],
    ]);
  });

  it("excludes archived sessions and sessions in archived projects", () => {
    const active = session("active");
    const archivedSession = session("archived");
    const inArchivedProject = { ...session("project-archived"), projectPath: "/work/old" };
    const groups = buildTraySessionGroups(
      [active, archivedSession, inArchivedProject],
      new Set([archivedSession.id, inArchivedProject.id]),
      [],
      {
        sessionMeta: { archived: { archived: true }, active: { pinned: true } },
        archivedProjectPaths: ["/work/old"],
        sort: "recent",
      },
    );
    expect(groups).toEqual([{ kind: "pinned", sessions: [{ id: "active", title: "active" }], hasMore: false }]);
  });
});

describe("parseTraySessionPreferences", () => {
  it("accepts extra session meta fields and rejects invalid payloads", () => {
    expect(
      parseTraySessionPreferences({
        sessionMeta: { "session-1": { pinned: true, manualTitle: true } },
        archivedProjectPaths: ["/work/app"],
        sort: "recent",
      }),
    ).toEqual({
      sessionMeta: { "session-1": { pinned: true, archived: undefined, order: undefined } },
      archivedProjectPaths: ["/work/app"],
      sort: "recent",
    });
    expect(parseTraySessionPreferences({ sessionMeta: {}, archivedProjectPaths: [], sort: "nope" })).toBeNull();
    expect(
      parseTraySessionPreferences({
        sessionMeta: { "session-1": { order: -1 } },
        archivedProjectPaths: [],
        sort: "recent",
      }),
    ).toBeNull();
  });
});

describe("traySessionTitle", () => {
  it("keeps one line and leaves a title inside the column budget alone", () => {
    expect(traySessionTitle(["line", "one"].join("\n"), "fallback")).toBe("line one");
    expect(traySessionTitle("   ", "fallback")).toBe("fallback");
    expect(traySessionTitle("a".repeat(32), "fallback")).toBe("a".repeat(32));
    expect(traySessionTitle("中".repeat(16), "fallback")).toBe("中".repeat(16));
  });

  it("cuts a Latin title to 31 columns plus an ellipsis", () => {
    expect(traySessionTitle("a".repeat(40), "fallback")).toBe(`${"a".repeat(31)}…`);
    // A cut that lands on a space never leaves it in front of the ellipsis.
    expect(traySessionTitle(`${"a".repeat(30)} ${"b".repeat(5)}`, "fallback")).toBe(
      `${"a".repeat(30)}…`,
    );
  });

  it("counts a CJK character as two columns, so half as many fit", () => {
    expect(traySessionTitle("中".repeat(20), "fallback")).toBe(`${"中".repeat(15)}…`);
    expect(traySessionTitle(`a${"中".repeat(20)}`, "fallback")).toBe(`a${"中".repeat(15)}…`);
  });

  it("counts an emoji as two columns, with or without the variation selector", () => {
    expect(traySessionTitle("😀".repeat(20), "fallback")).toBe(`${"😀".repeat(15)}…`);
    expect(traySessionTitle("✅".repeat(20), "fallback")).toBe(`${"✅".repeat(15)}…`);
    const sun = "\u2600\ufe0f";
    expect(traySessionTitle(sun.repeat(21), "fallback")).toBe(`${sun.repeat(15)}…`);
  });

  it("counts a combining mark as nothing and drops a joiner left by the cut", () => {
    expect(traySessionTitle("e\u0301".repeat(40), "fallback")).toBe(
      `${"e\u0301".repeat(31)}…`,
    );
    expect(traySessionTitle(`${"a".repeat(29)}\u{1f468}\u200d${"b".repeat(3)}`, "fallback")).toBe(
      `${"a".repeat(29)}\u{1f468}…`,
    );
  });
});
