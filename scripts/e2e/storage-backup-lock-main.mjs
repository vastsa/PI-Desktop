import assert from "node:assert/strict";
import { app } from "electron";
import { promises as fs } from "original-fs";
import { join } from "node:path";
import { removeBackups } from "../../apps/desktop/electron/main/storage/files.ts";

const directory = process.env.PI_STORAGE_BACKUP_ARTIFACTS;
const anchor = join(directory, "installation");
app.setPath("userData", anchor);
const result = { electron: process.versions.electron, passed: false };
const acquired = app.requestSingleInstanceLock();

void (async () => {
  assert(acquired, "The isolated installation lock is held");
  if (process.platform === "win32") {
    assert((await fs.lstat(join(anchor, "lockfile"))).isFile(), "Electron created the reported Windows lock");
  }
  const active = { data: join(directory, "active-data"), browser: join(directory, "active-browser") };
  // Reproduce retry after cleanup already removed the old payload: only the
  // stable pointer and real lock remain. No user data or disposable files exist.
  await removeBackups([{ data: join(directory, "already-removed-data"), browser: anchor }], active, anchor);
  assert.equal(app.hasSingleInstanceLock(), true);
  assert.equal(await fs.readFile(join(anchor, "storage-location.json"), "utf8"), "retained pointer");
  assert.equal(await fs.readFile(join(active.data, "history.txt"), "utf8"), "current history");
  if (process.platform === "win32") assert((await fs.lstat(join(anchor, "lockfile"))).isFile());
  result.passed = true;
  result.lockRetained = true;
  result.activeHistoryRetained = true;
})().catch(error => { result.error = error.message; }).finally(async () => {
  await fs.writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2));
  app.exit(result.passed ? 0 : 1);
});
