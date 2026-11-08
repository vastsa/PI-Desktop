import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { readSidebarBackup, writeSidebarBackup } from "../electron/main/sidebar-preferences.ts";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerSidebarPreferencesIpc } = await import("../electron/main/ipc/sidebar-preferences-ipc.ts");
const { IPC } = await import("@pi-desktop/shared");

test("sidebar IPC rejects untrusted callers before reading or writing the selected profile", async t => {
  const root = await mkdtemp(join(tmpdir(), "sidebar-ipc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const handlers = new Map();
  registerSidebarPreferencesIpc({ dataDir: root, registrar: {
    handleWithEvent: (channel, handler) => handlers.set(channel, handler),
    assertMainWindowSender: event => { if (!event.trusted) throw new Error("Denied"); },
  } });
  const get = event => handlers.get(IPC.invoke.sidebarPreferencesGet)(event);
  const set = (event, value) => handlers.get(IPC.invoke.sidebarPreferencesSet)(event, value);
  const value = { sessionMeta: {}, projectMeta: {}, sessionView: {}, openProjectPaths: ["/alpha"] };
  const frame = { url: "file:///synthetic/index.html" };
  const trusted = { trusted: true, senderFrame: frame, sender: { mainFrame: frame, getURL: () => frame.url } };
  await assert.rejects(set({}, value), /Denied/);
  await assert.rejects(get({}), /Denied/);
  await assert.rejects(set({ ...trusted, senderFrame: { url: frame.url } }, value), /top frame/);
  assert.equal(await get(trusted), null);
  await set(trusted, value);
  assert.deepEqual(await get(trusted), value);
});

test("sidebar layout survives a fresh renderer and a Main service reload in the selected data root", async t => {
  const root = await mkdtemp(join(tmpdir(), "sidebar-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first"), second = join(root, "second");
  assert.equal(readSidebarBackup(first), null);
  const value = { sessionMeta: {}, projectMeta: {}, sessionView: {}, openProjectPaths: ["/synthetic/alpha"] };
  writeSidebarBackup(first, value);
  assert.deepEqual(readSidebarBackup(first), value);
  assert.equal(readSidebarBackup(second), null, "profiles must not share layouts");
  writeSidebarBackup(first, { ...value, openProjectPaths: [] });
  assert.deepEqual(readSidebarBackup(first).openProjectPaths, [], "an explicit close is durable");
  assert.throws(() => writeSidebarBackup(first, { openProjectPaths: "invalid" }), /Invalid/);
  assert.throws(() => writeSidebarBackup(first, { ...value, extra: "x".repeat(2 * 1024 * 1024) }), /size limit/);
  assert.deepEqual(readSidebarBackup(first).openProjectPaths, [], "rejected writes preserve the last good file");
});

test("unreadable and corrupt backups remain errors instead of permission to overwrite", async t => {
  const root = await mkdtemp(join(tmpdir(), "sidebar-backup-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "sidebar-preferences.json");
  await writeFile(path, "{broken");
  assert.throws(() => readSidebarBackup(root), SyntaxError);
  assert.equal(await readFile(path, "utf8"), "{broken");
});
