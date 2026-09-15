import { describe, expect, it } from "vitest";
import {
  allocateTraySessionRows,
  buildTraySessionGroups,
  type TraySessionPreferences,
} from "./tray-sessions.js";
import type { SessionSummary } from "./types/sessions.js";

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
});
