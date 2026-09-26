import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dirname, join as pathJoin } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(pathJoin(here, "helpers/ts-import-hooks.mjs")));

const {
  adoptRelocatedUpdateCache,
  defaultUpdateCacheBasePath,
  discardDownloadedUpdate,
  readUpdaterCacheDirName,
  resolveUpdateCacheOverride,
  sameUpdateCacheDir,
  updateCacheDirFor,
} = await import("../electron/main/update-cache.ts");
const { UpdateCacheMaintenance } = await import("../electron/main/update-cache-maintenance.ts");

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-update-cache-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("default updater cache base mirrors electron-updater on supported platforms", () => {
  assert.equal(
    defaultUpdateCacheBasePath({
      platform: "win32",
      env: { LOCALAPPDATA: "C:/Users/A/AppData/Local" },
      home: "C:/Users/A",
    }),
    "C:/Users/A/AppData/Local",
  );
  assert.equal(
    defaultUpdateCacheBasePath({ platform: "win32", env: {}, home: "/home/a" }),
    "/home/a/AppData/Local",
  );
  assert.equal(
    defaultUpdateCacheBasePath({ platform: "darwin", env: {}, home: "/Users/a" }),
    "/Users/a/Library/Caches",
  );
  assert.equal(
    defaultUpdateCacheBasePath({
      platform: "linux",
      env: { XDG_CACHE_HOME: "/mnt/cache" },
      home: "/home/a",
    }),
    "/mnt/cache",
  );
});

test("cache override requires an absolute path and uses app-update.yml's directory name", () => {
  assert.equal(resolveUpdateCacheOverride(undefined), null);
  assert.equal(resolveUpdateCacheOverride("  "), null);
  assert.equal(resolveUpdateCacheOverride("relative/cache"), null);
  assert.equal(resolveUpdateCacheOverride("/mnt/PI cache"), "/mnt/PI cache");
  assert.equal(
    readUpdaterCacheDirName("provider: github\nupdaterCacheDirName: '@pi-desktopdesktop-updater'\n"),
    "@pi-desktopdesktop-updater",
  );
  assert.equal(readUpdaterCacheDirName("provider: github\n"), null);
  assert.equal(readUpdaterCacheDirName("updaterCacheDirName: ../outside"), null);
  assert.equal(readUpdaterCacheDirName("updaterCacheDirName: nested/path"), null);
  assert.equal(
    updateCacheDirFor("/mnt/cache", "@pi-desktopdesktop-updater"),
    "/mnt/cache/@pi-desktopdesktop-updater",
  );
  assert.equal(sameUpdateCacheDir("C:/Cache/UPDATER", "c:/cache/updater", "win32"), true);
  assert.equal(sameUpdateCacheDir("/Cache/UPDATER", "/cache/updater", "linux"), false);
});

test("discarding a completed update removes only the pending installers", async () => {
  await withTempDir(async (root) => {
    const cache = join(root, "cache");
    const pending = join(cache, "pending");
    await mkdir(pending, { recursive: true });
    await writeFile(join(pending, "PI-Desktop-Setup-0.15.8.exe"), "installer");
    await writeFile(join(pending, "update-info.json"), "{}");
    await writeFile(join(cache, "installer.exe"), "differential baseline");
    await writeFile(join(cache, "current.blockmap"), "block map");

    await discardDownloadedUpdate(cache);

    assert.deepEqual(await readdir(cache), ["current.blockmap", "installer.exe"]);
    assert.equal(await readFile(join(cache, "installer.exe"), "utf8"), "differential baseline");
    assert.equal(await readFile(join(cache, "current.blockmap"), "utf8"), "block map");
  });
});

test("adopting a relocated cache carries the NSIS delta baseline and removes the old cache", async () => {
  await withTempDir(async (root) => {
    const oldCache = join(root, "old-cache", "@pi-updater");
    const activeCache = join(root, "D-drive", "@pi-updater");
    await mkdir(join(oldCache, "pending"), { recursive: true });
    await writeFile(join(oldCache, "installer.exe"), "installed version baseline");
    await writeFile(join(oldCache, "current.blockmap"), "installed version map");
    await writeFile(join(oldCache, "pending", "old-setup.exe"), "old installer");

    await adoptRelocatedUpdateCache(activeCache, oldCache, "win32");

    assert.equal(await readFile(join(activeCache, "pending", "old-setup.exe"), "utf8"), "old installer");
    assert.equal(await readFile(join(activeCache, "installer.exe"), "utf8"), "installed version baseline");
    assert.equal(await readFile(join(activeCache, "current.blockmap"), "utf8"), "installed version map");
    await assert.rejects(readdir(oldCache), { code: "ENOENT" });
  });
});
test("relocation does not overwrite active cache data or delete unknown legacy files", async () => {
  await withTempDir(async (root) => {
    const oldCache = join(root, "old-cache");
    const activeCache = join(root, "active-cache");
    await mkdir(join(oldCache, "pending"), { recursive: true });
    await mkdir(join(activeCache, "pending"), { recursive: true });
    await writeFile(join(oldCache, "installer.exe"), "legacy baseline");
    await writeFile(join(activeCache, "installer.exe"), "active baseline");
    await writeFile(join(oldCache, "pending", "staged.exe"), "legacy staged update");
    await writeFile(join(activeCache, "pending", "staged.exe"), "active staged update");
    await writeFile(join(oldCache, "user-file"), "unrecognized file");

    await adoptRelocatedUpdateCache(activeCache, oldCache, "win32");

    assert.equal(await readFile(join(activeCache, "installer.exe"), "utf8"), "active baseline");
    assert.equal(await readFile(join(activeCache, "pending", "staged.exe"), "utf8"), "active staged update");
    assert.equal(await readFile(join(oldCache, "user-file"), "utf8"), "unrecognized file");
  });
});

test("adopting a relocated cache tolerates an absent old cache", async () => {
  await withTempDir(async (root) => {
    await adoptRelocatedUpdateCache(join(root, "active"), join(root, "missing"), "win32");
    await assert.rejects(readdir(join(root, "missing")), { code: "ENOENT" });
  });
});
test("cache maintenance reads the packaged updater name, adopts baselines, then discards stale staging", async () => {
  await withTempDir(async (root) => {
    const resources = join(root, "resources");
    const legacyBase = join(root, "legacy-base");
    const activeBase = join(root, "active-base");
    const cacheName = "@pi-desktopdesktop-updater";
    const legacyCache = join(legacyBase, cacheName);
    const activeCache = join(activeBase, cacheName);
    await mkdir(resources, { recursive: true });
    await writeFile(
      join(resources, "app-update.yml"),
      `provider: github\nupdaterCacheDirName: '${cacheName}'\n`,
    );
    await mkdir(join(legacyCache, "pending"), { recursive: true });
    await writeFile(join(legacyCache, "installer.exe"), "baseline");
    await writeFile(join(legacyCache, "current.blockmap"), "blockmap");
    await writeFile(join(legacyCache, "pending", "next-setup.exe"), "pending update");
    const logs = [];
    const maintenance = new UpdateCacheMaintenance({
      resourcesPath: resources,
      activeBasePath: activeBase,
      legacyBasePath: legacyBase,
      logger: { app: (...args) => logs.push(args) },
    });

    await maintenance.reclaimLegacyCache();
    assert.equal(await readFile(join(activeCache, "installer.exe"), "utf8"), "baseline");
    assert.equal(await readFile(join(activeCache, "current.blockmap"), "utf8"), "blockmap");
    assert.equal(await readFile(join(activeCache, "pending", "next-setup.exe"), "utf8"), "pending update");
    await maintenance.discardDownloadedInstaller();
    assert.deepEqual((await readdir(activeCache)).sort(), ["current.blockmap", "installer.exe"]);
    assert.equal(logs[0][2], "adopted the relocated update cache");
  });
});
