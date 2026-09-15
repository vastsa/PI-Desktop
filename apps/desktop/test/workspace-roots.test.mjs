import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  knownProjectGroups,
  pluginWorkspaceInfo,
  projectFolderPaths,
  refreshProjectGroups,
  rememberProjectGroups,
  workspaceRootsFor,
} = await import("../electron/main/workspace-roots.ts");

/**
 * The project group behind the one visible workspace (ADR 0249, ADR 0252).
 *
 * `pi.workspace.get` and the `workspace:changed` broadcast both read this, so
 * the snapshot has to be the single answer: a group's folders in group order
 * with the primary root flagged, an ungrouped workspace reduced to the payload
 * it has always had, and a cold or vanished snapshot reduced to the same rather
 * than to a guess.
 */

const group = {
  id: "grp-1",
  name: "Two folders",
  primaryPath: "C:\\work\\alpha",
  roots: [
    { path: "C:\\work\\alpha", name: "alpha", position: 0 },
    { path: "C:\\work\\beta", name: "beta", position: 1 },
    { path: "C:\\work\\gamma", name: "gamma", position: 2 },
  ],
  createdAt: 0,
  updatedAt: 0,
  pinned: false,
  lastOpenedAt: 0,
};

function resetTo(groups) {
  rememberProjectGroups(groups);
}

test("a workspace inside a group reports every folder, primary first", () => {
  resetTo([group]);
  const payload = workspaceRootsFor("C:\\work\\alpha");
  assert.equal(payload.projectId, "grp-1");
  assert.deepEqual(payload.roots, [
    { path: "C:\\work\\alpha", name: "alpha", primary: true },
    { path: "C:\\work\\beta", name: "beta", primary: false },
    { path: "C:\\work\\gamma", name: "gamma", primary: false },
  ]);
});

test("any folder of the group resolves to the same group", () => {
  resetTo([group]);
  // The visible workspace is the primary root, but a session's path can be any
  // registered folder, and both must describe the same project.
  assert.equal(workspaceRootsFor("C:\\work\\beta").projectId, "grp-1");
  assert.equal(workspaceRootsFor("C:\\work\\gamma").roots?.length, 3);
  // Spelling differences must not lose the group: separators, a trailing
  // slash, and Windows' case-insensitivity.
  assert.equal(workspaceRootsFor("C:/work/alpha").projectId, "grp-1");
  assert.equal(workspaceRootsFor("C:\\work\\alpha\\").projectId, "grp-1");
  assert.equal(workspaceRootsFor("c:\\WORK\\Beta").projectId, "grp-1");
});

test("an ungrouped or unknown workspace stays the pre-group payload", () => {
  resetTo([group]);
  assert.deepEqual(workspaceRootsFor("D:\\elsewhere"), {});
  assert.deepEqual(workspaceRootsFor(null), {});
  resetTo(null);
  assert.deepEqual(workspaceRootsFor("C:\\work\\alpha"), {});
  assert.equal(knownProjectGroups(), null);
});

test("the plugin payload keeps path and name and adds the folders", () => {
  resetTo([group]);
  assert.deepEqual(pluginWorkspaceInfo("C:\\work\\beta"), {
    path: "C:\\work\\beta",
    name: "beta",
    projectId: "grp-1",
    roots: [
      { path: "C:\\work\\alpha", name: "alpha", primary: true },
      { path: "C:\\work\\beta", name: "beta", primary: false },
      { path: "C:\\work\\gamma", name: "gamma", primary: false },
    ],
  });
  // Name derivation is unchanged for a path with no group behind it.
  assert.deepEqual(pluginWorkspaceInfo("D:\\solo\\project"), {
    path: "D:\\solo\\project",
    name: "project",
  });
  assert.equal(pluginWorkspaceInfo(null), null);
  assert.equal(pluginWorkspaceInfo(""), null);
});

test("roots are ordered by position, not by their order in the record", () => {
  resetTo([
    {
      ...group,
      roots: [
        { path: "C:\\work\\gamma", name: "gamma", position: 2 },
        { path: "C:\\work\\alpha", name: "alpha", position: 0 },
        { path: "C:\\work\\beta", name: "beta", position: 1 },
      ],
    },
  ]);
  assert.deepEqual(
    workspaceRootsFor("C:\\work\\alpha").roots?.map((root) => root.name),
    ["alpha", "beta", "gamma"],
  );
});

test("containment family is the group, or the workspace alone", () => {
  resetTo([group]);
  assert.deepEqual(projectFolderPaths("C:\\work\\beta"), [
    "C:\\work\\alpha",
    "C:\\work\\beta",
    "C:\\work\\gamma",
  ]);
  resetTo(null);
  assert.deepEqual(projectFolderPaths("C:\\work\\beta"), ["C:\\work\\beta"]);
  assert.deepEqual(projectFolderPaths(null), []);
});

test("refresh replaces the snapshot and reports whether it changed", async () => {
  resetTo(null);
  let answer = { groups: [group] };
  const host = {
    isAvailable: () => true,
    call: async () => answer,
  };
  assert.equal(await refreshProjectGroups(host), true);
  assert.equal(knownProjectGroups()?.length, 1);
  // The same answer again is not a change: callers must not rebroadcast.
  assert.equal(await refreshProjectGroups(host), false);

  answer = { groups: [{ ...group, roots: [group.roots[0]] }] };
  assert.equal(await refreshProjectGroups(host), true);
  assert.equal(workspaceRootsFor("C:\\work\\alpha").roots?.length, 1);

  // A host that throws clears the snapshot rather than keeping a stale one.
  const broken = {
    isAvailable: () => true,
    call: async () => {
      throw new Error("host gone");
    },
  };
  assert.equal(await refreshProjectGroups(broken), true);
  assert.equal(knownProjectGroups(), null);
  // And an absent host is a no-op, not a clear.
  rememberProjectGroups([group]);
  assert.equal(await refreshProjectGroups(null), false);
  assert.equal(knownProjectGroups()?.length, 1);
  assert.equal(
    await refreshProjectGroups({ isAvailable: () => false, call: async () => ({}) }),
    false,
  );
});
