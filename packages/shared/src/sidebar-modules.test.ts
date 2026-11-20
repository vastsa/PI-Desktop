import { describe, expect, it } from "vitest";
import {
  SIDEBAR_MODULE_IDS,
  normalizeSidebarModulePreferences,
  sidebarModuleEnabled,
  sidebarModuleVisible,
  sidebarModulesWriteError,
} from "./sidebar-modules.js";

describe("sidebar modules", () => {
  it("shows every module when the preference is absent", () => {
    for (const id of SIDEBAR_MODULE_IDS) {
      expect(sidebarModuleVisible(undefined, id)).toBe(true);
      expect(sidebarModuleVisible({}, id)).toBe(true);
    }
  });

  it("hides only modules explicitly set to false", () => {
    const prefs = { scheduled: false, pluginMarket: true };
    expect(sidebarModuleVisible(prefs, "scheduled")).toBe(false);
    expect(sidebarModuleVisible(prefs, "pluginMarket")).toBe(true);
    expect(sidebarModuleVisible(prefs, "newTask")).toBe(true);
  });

  it("hides a section's buttons with the section but keeps their own switch", () => {
    const prefs = { sessions: false, sessionSort: true };
    expect(sidebarModuleVisible(prefs, "sessionSort")).toBe(false);
    expect(sidebarModuleVisible(prefs, "newSession")).toBe(false);
    expect(sidebarModuleEnabled(prefs, "sessionSort")).toBe(true);
    expect(sidebarModuleVisible({ projects: false }, "newProject")).toBe(false);
    expect(sidebarModuleVisible({ projects: false }, "projectNewTask")).toBe(false);
  });

  it("drops unknown keys and non-boolean values when normalizing", () => {
    expect(
      normalizeSidebarModulePreferences({
        sessions: false,
        projects: "no",
        futureModule: false,
      }),
    ).toEqual({ sessions: false });
    expect(normalizeSidebarModulePreferences(null)).toEqual({});
    expect(normalizeSidebarModulePreferences([false])).toEqual({});
  });

  it("rejects malformed writes and tolerates unknown boolean keys", () => {
    expect(sidebarModulesWriteError(undefined)).toBeNull();
    expect(sidebarModulesWriteError({ sessions: false, futureModule: true })).toBeNull();
    expect(sidebarModulesWriteError(null)).toBe("sidebarModules is invalid");
    expect(sidebarModulesWriteError([])).toBe("sidebarModules is invalid");
    expect(sidebarModulesWriteError({ sessions: "off" })).toBe(
      "sidebarModules.sessions is invalid",
    );
  });
});
