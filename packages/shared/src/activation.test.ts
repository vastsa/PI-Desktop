import { describe, expect, it } from "vitest";
import {
  activationState,
  GLOBAL_SCOPE,
  isActiveInProject,
  normalizeProjectPath,
  projectPathMatches,
  resolveScope,
  withoutProject,
  withProject,
} from "./activation.js";

describe("normalizeProjectPath", () => {
  it("uses forward slashes and drops trailing separators", () => {
    expect(normalizeProjectPath("C:\\work\\app\\")).toBe("C:/work/app");
    expect(normalizeProjectPath("/Users/me/app//")).toBe("/Users/me/app");
  });

  it("keeps a drive root intact", () => {
    expect(normalizeProjectPath("C:/")).toBe("C:/");
  });

  it("treats blank input as no path", () => {
    expect(normalizeProjectPath("   ")).toBe("");
    expect(normalizeProjectPath(undefined)).toBe("");
  });
});

describe("projectPathMatches", () => {
  it("matches the same directory regardless of case or trailing slash", () => {
    expect(projectPathMatches("/Users/me/App/", "/users/me/app", "darwin")).toBe(true);
  });

  it("matches a subdirectory of the scoped root", () => {
    expect(projectPathMatches("/repo", "/repo/packages/web")).toBe(true);
  });

  it("does not match a sibling with a shared prefix", () => {
    expect(projectPathMatches("/repo", "/repo-other")).toBe(false);
  });

  it("never matches when either side is blank", () => {
    expect(projectPathMatches("", "/repo")).toBe(false);
    expect(projectPathMatches("/repo", "")).toBe(false);
  });
});

describe("resolveScope", () => {
  it("falls back to global for missing or unknown modes", () => {
    expect(resolveScope(undefined)).toEqual(GLOBAL_SCOPE);
    expect(resolveScope({ mode: "nonsense" as never, projects: [] })).toEqual(GLOBAL_SCOPE);
  });

  it("normalizes and de-duplicates the project list", () => {
    expect(
      resolveScope({
        mode: "projects",
        projects: ["/repo/", "/REPO", "", "/other"],
      }, "win32"),
    ).toEqual({ mode: "projects", projects: ["/repo", "/other"] });
  });
});

describe("isActiveInProject", () => {
  it("is inactive when disabled, whatever the scope says", () => {
    expect(isActiveInProject({ enabled: false, scope: GLOBAL_SCOPE }, "/repo")).toBe(false);
  });

  it("is active everywhere when global, including sessions with no project", () => {
    expect(isActiveInProject({ enabled: true }, null)).toBe(true);
    expect(isActiveInProject({ enabled: true, scope: GLOBAL_SCOPE }, "/repo")).toBe(true);
  });

  it("is active only inside the listed projects", () => {
    const item = { enabled: true, scope: { mode: "projects" as const, projects: ["/repo"] } };
    expect(isActiveInProject(item, "/repo")).toBe(true);
    expect(isActiveInProject(item, "/repo/apps/web")).toBe(true);
    expect(isActiveInProject(item, "/elsewhere")).toBe(false);
  });

  it("is inactive in a project-scoped state when the session has no project", () => {
    const item = { enabled: true, scope: { mode: "projects" as const, projects: ["/repo"] } };
    expect(isActiveInProject(item, null)).toBe(false);
  });

  it("is inactive when project mode carries an empty list", () => {
    expect(
      isActiveInProject({ enabled: true, scope: { mode: "projects", projects: [] } }, "/repo"),
    ).toBe(false);
  });
});

it("selects and removes Linux case variants independently", () => {
  const first = withProject(GLOBAL_SCOPE, "/work/project", "linux");
  expect(isActiveInProject({ enabled: true, scope: first }, "/work/Project", "linux")).toBe(false);
  const both = withProject(first, "/work/Project", "linux");
  expect(both.projects).toEqual(["/work/project", "/work/Project"]);
  expect(isActiveInProject({ enabled: true, scope: both }, "/work/Project/child", "linux")).toBe(true);
  expect(withoutProject(both, "/work/project", "linux").projects).toEqual(["/work/Project"]);
});

describe("activationState", () => {
  it("collapses the record into the control's three states", () => {
    expect(activationState({ enabled: false })).toBe("off");
    expect(activationState({ enabled: true })).toBe("global");
    expect(
      activationState({ enabled: true, scope: { mode: "projects", projects: ["/repo"] } }),
    ).toBe("projects");
  });
});

describe("withProject / withoutProject", () => {
  it("switches to project mode and keeps entries unique", () => {
    const once = withProject(GLOBAL_SCOPE, "/repo");
    expect(once).toEqual({ mode: "projects", projects: ["/repo"] });
    expect(withProject(once, "/REPO/", "darwin")).toEqual(once);
  });

  it("removes an entry without changing the mode", () => {
    const scope = { mode: "projects" as const, projects: ["/a", "/b"] };
    expect(withoutProject(scope, "/A", "win32")).toEqual({ mode: "projects", projects: ["/b"] });
  });

  it("keeps the project list when a scope loses its last entry", () => {
    const scope = { mode: "projects" as const, projects: ["/a"] };
    expect(withoutProject(scope, "/a")).toEqual({ mode: "projects", projects: [] });
  });
});
