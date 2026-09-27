import assert from "node:assert/strict";
import test from "node:test";
import {
  groupSidebarSessions,
  normalizeProjectPath,
  sessionMatchesProject,
} from "../src/lib/sidebar-session-groups.ts";

function session(overrides) {
  return {
    id: "session-1",
    title: "Session",
    projectPath: undefined,
    mode: "agent",
    createdAt: "2026-07-25T10:00:00.000Z",
    updatedAt: "2026-07-25T11:00:00.000Z",
    ...overrides,
  };
}

test("shows only the current project and path-less temporary sessions", () => {
  const groups = groupSidebarSessions(
    [
      session({ id: "current", projectPath: "/work/current" }),
      session({ id: "other", projectPath: "/work/other" }),
      session({ id: "temporary" }),
    ],
    "/work/current/",
  );

  assert.deepEqual(
    groups.projectSessions.map((item) => item.id),
    ["current"],
  );
  assert.deepEqual(
    groups.temporarySessions.map((item) => item.id),
    ["temporary"],
  );
});

test("normalizes separators and trailing slashes for project matching", () => {
  assert.equal(normalizeProjectPath("C:\\work\\project\\"), "C:/work/project");
  assert.equal(
    sessionMatchesProject(session({ projectPath: "C:\\work\\project" }), "C:/work/project/"),
    true,
  );
});

test("strips Windows extended-length path prefix", () => {
  // Forward-slash variant stored by older DB versions
  assert.equal(normalizeProjectPath("//?/C:/Users/mi/project"), "C:/Users/mi/project");
  assert.equal(normalizeProjectPath("//?/D:/work/app"), "D:/work/app");
  // Backslash variant from canonicalize
  assert.equal(normalizeProjectPath("\\\\?\\C:\\Users\\mi\\project"), "C:/Users/mi/project");
  // Drive-root path (trailing slash preserved as single slash)
  assert.equal(normalizeProjectPath("//?/C:/"), "C:/");
  assert.equal(normalizeProjectPath("\\\\?\\C:\\"), "C:/");
  // Non-drive UNC paths are left intact (stripped of leading slashes by the normalize logic)
  assert.equal(normalizeProjectPath("//?/UNC/server/share"), "//?/UNC/server/share");
});

test("treats blank project paths as temporary", () => {
  const groups = groupSidebarSessions(
    [session({ id: "blank", projectPath: "   " }), session({ id: "missing" })],
    "/work/current",
  );

  assert.deepEqual(
    groups.temporarySessions.map((item) => item.id),
    ["blank", "missing"],
  );
});
