import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { createLanOrganization } = await import("../electron/main/lan-webui/organization.ts");
const { writeSidebarBackup } = await import("../electron/main/sidebar-preferences.ts");

function profile() {
  const dataDir = mkdtempSync(join(tmpdir(), "lan-org-"));
  writeSidebarBackup(dataDir, {
    openProjectPaths: ["/work/a"],
    projectMeta: { "/work/a": { name: "Alpha", collapsed: true } },
    sessionMeta: { s1: { pinned: true, order: 3 } },
    sessionView: { sort: "recent", archived: false },
    projectSort: "recent",
  });
  return { dataDir, read: () => JSON.parse(readFileSync(join(dataDir, "sidebar-preferences.json"), "utf8")) };
}

test("a browser edit is durable and keeps unrelated Desktop preferences", (t) => {
  const { dataDir, read } = profile();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const events = [];
  const organization = createLanOrganization({ dataDir, notify: (event) => events.push(event) });

  organization.patch({ kind: "session", key: "s1", patch: { archived: true } });
  organization.patch({ kind: "project", key: "/work/a/", patch: { pinned: true } });

  const disk = read();
  assert.deepEqual(disk.sessionMeta.s1, { pinned: true, order: 3, archived: true });
  assert.deepEqual(disk.projectMeta["/work/a"], { name: "Alpha", collapsed: true, pinned: true });
  assert.deepEqual(disk.openProjectPaths, ["/work/a"]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  assert.equal(organization.read().sessionMeta.s1.archived, true);
});

test("a stale renderer snapshot cannot undo an unacknowledged browser edit", (t) => {
  const { dataDir } = profile();
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const organization = createLanOrganization({ dataDir });
  const stale = {
    openProjectPaths: ["/work/a"],
    projectMeta: { "/work/a": { name: "Alpha" } },
    sessionMeta: { s1: { pinned: true }, s2: { pinned: true } },
    sessionView: { sort: "recent", archived: false },
  };

  organization.patch({ kind: "session", key: "s1", patch: { pinned: false } });
  const merged = organization.overlay(stale);
  assert.equal(merged.sessionMeta.s1.pinned, false, "the browser edit wins over the stale write");
  assert.equal(merged.sessionMeta.s2.pinned, true, "other Desktop changes in the snapshot are kept");
  assert.equal(stale.sessionMeta.s1.pinned, true, "the caller's object is not mutated");

  // After the renderer acknowledges, its later snapshots are authoritative again.
  organization.ack(1);
  assert.equal(organization.pendingCount(), 0);
  assert.equal(organization.overlay(stale).sessionMeta.s1.pinned, true);
});

test("a missing or damaged backup is never replaced from a browser edit", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "lan-org-empty-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const organization = createLanOrganization({ dataDir });
  organization.patch({ kind: "session", key: "s9", patch: { archived: true } });
  assert.throws(() => readFileSync(join(dataDir, "sidebar-preferences.json")), /ENOENT/);
  // The edit stays pending and is applied to the first renderer write.
  const first = organization.overlay({ openProjectPaths: [], projectMeta: {}, sessionMeta: {}, sessionView: {} });
  assert.equal(first.sessionMeta.s9.archived, true);
});
