import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
register(pathToFileURL(join(here, "helpers/updater-module-stubs.mjs")));

const { AppUpdaterController } = await import("../electron/main/updater.ts");

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  logger = null;
  nextVersion = "0.16.1";
  downloadStarts = [];
  cancellations = [];

  async checkForUpdates() {
    this.emit("checking-for-update");
    const info = {
      version: this.nextVersion,
      files: [],
      path: "",
      sha512: "",
      releaseDate: "2026-10-03T00:00:00.000Z",
    };
    this.emit("update-available", info);
    const cancellationToken = {
      cancel: () => {
        this.cancellations.push(info.version);
        this.emit("update-cancelled", info);
      },
    };
    const downloadPromise = this.autoDownload
      ? (this.downloadStarts.push(info.version), Promise.resolve([]))
      : null;
    return { updateInfo: info, cancellationToken, downloadPromise };
  }

  async downloadUpdate() {
    return [];
  }

  quitAndInstall() {}
}

function createController({ updater, settings = {}, persist = async () => {}, options = {} }) {
  const logger = { app: () => {} };
  const sent = [];
  const controller = new AppUpdaterController({
    logger,
    send: (channel, payload) => sent.push({ channel, payload }),
    currentVersion: "0.16.0",
    platform: "darwin",
    isPackaged: true,
    autoUpdater: updater,
    readUpdateSettings: async () => settings,
    persistDismissedVersion: persist,
    ...options,
  });
  return { controller, sent };
}

/**
 * The Electron stub answers `app.getAppPath()` with the working directory, so
 * a packaged app's metadata is whatever `package.json` sits there.
 */
async function withPackagedMetadata(metadata, run) {
  const previous = process.cwd();
  const appPath = await mkdtemp(join(tmpdir(), "pi-desktop-updater-metadata-"));
  await writeFile(join(appPath, "package.json"), JSON.stringify(metadata));
  process.chdir(appPath);
  try {
    return await run();
  } finally {
    process.chdir(previous);
    await rm(appPath, { recursive: true, force: true });
  }
}

test("dismissing an in-app update cancels its download and disables install on quit", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  const { controller } = createController({
    updater,
    persist: async (version) => persisted.push(version),
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, ["0.16.1"]);
  assert.equal(controller.getState().status, "downloading");

  await controller.dismiss();

  assert.deepEqual(updater.cancellations, ["0.16.1"]);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().status, "available");
  assert.equal(controller.getState().dismissed, true);
  assert.deepEqual(persisted, ["0.16.1"]);
  controller.dispose();
});

test("a restored dismissal blocks that release and a newer release resumes automatic delivery", async () => {
  const updater = new FakeUpdater();
  const persisted = [];
  let clearDismissal;
  const cleared = new Promise((resolve) => {
    clearDismissal = resolve;
  });
  const { controller } = createController({
    updater,
    settings: { updatePreference: "automatic", updateDismissedVersion: "0.16.1" },
    persist: async (version) => {
      persisted.push(version);
      if (version === null) clearDismissal();
    },
  });

  await controller.check();
  assert.deepEqual(updater.downloadStarts, []);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(controller.getState().dismissed, true);

  updater.nextVersion = "0.16.2";
  await controller.check();
  await cleared;
  assert.deepEqual(updater.downloadStarts, ["0.16.2"]);
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(controller.getState().dismissed, false);
  assert.deepEqual(persisted, [null]);
  controller.dispose();
});

test("a packaged macOS build stamped unsigned never downloads, even with a stored automatic preference", async () => {
  await withPackagedMetadata({ piDistribution: "unsigned" }, async () => {
    const updater = new FakeUpdater();
    const { controller } = createController({
      updater,
      settings: { updatePreference: "automatic" },
    });

    await controller.check();

    assert.equal(controller.getState().mode, "manual");
    assert.equal(controller.getState().status, "available");
    assert.deepEqual(updater.downloadStarts, []);
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    await assert.rejects(controller.download(), /not supported on this install/);
    controller.dispose();
  });
});

test("a packaged macOS build with ordinary or unreadable metadata keeps in-app delivery", async () => {
  for (const metadata of [{ piDistribution: "installed" }, { piDistribution: 7 }, {}]) {
    await withPackagedMetadata(metadata, async () => {
      const updater = new FakeUpdater();
      const { controller } = createController({ updater });
      await controller.check();
      assert.equal(controller.getState().mode, "in-app");
      assert.deepEqual(updater.downloadStarts, ["0.16.1"]);
      controller.dispose();
    });
  }
});
