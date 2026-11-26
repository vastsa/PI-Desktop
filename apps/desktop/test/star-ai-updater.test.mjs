import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";
import {
  buildBugReportUrl,
  GITHUB_RELEASES_URL,
  GITHUB_REPO,
} from "@pi-desktop/shared";

const electronStub = "data:text/javascript," + encodeURIComponent(`
  export const app = { isPackaged: true, getAppPath: () => process.cwd() };
  export const net = { fetch: globalThis.fetch };
  export const shell = { openExternal: async () => {} };
`);
const updaterStub = "data:text/javascript," + encodeURIComponent(`
  export default { NsisUpdater: class {}, autoUpdater: {} };
`);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") return { url: electronStub, shortCircuit: true };
    if (specifier === "electron-updater") return { url: updaterStub, shortCircuit: true };
    if (context.parentURL?.includes("/electron/main/") && /^\.\/[\w-]+$/.test(specifier)) {
      return next(specifier + ".ts", context);
    }
    return next(specifier, context);
  },
});

const {
  AppUpdaterController,
  compareReleaseVersions,
  RELEASES_URL,
} = await import("../electron/main/updater.ts");
hooks.deregister();

const noopLogger = { app: () => {} };

test("StarAI repo metadata and feedback links point to gexing521/StarAi-Desktop", () => {
  assert.equal(GITHUB_REPO, "gexing521/StarAi-Desktop");
  assert.equal(RELEASES_URL, "https://github.com/gexing521/StarAi-Desktop/releases");
  assert.equal(GITHUB_RELEASES_URL, RELEASES_URL);
  const url = new URL(
    buildBugReportUrl({
      version: "0.24.0-beta.5",
      platform: "darwin",
      arch: "arm64",
      protocolVersion: 11,
      hostVersion: "0.24.0-beta.5",
    }),
  );
  assert.equal(url.pathname, "/gexing521/StarAi-Desktop/issues/new");
  assert.match(url.searchParams.get("environment") ?? "", /^StarAI Desktop 0\.24\.0-beta\.5/);
});

test("compareReleaseVersions orders stable releases above beta prereleases", () => {
  assert.ok(compareReleaseVersions("0.24.0", "0.24.0-beta.5") > 0);
  assert.ok(compareReleaseVersions("0.24.0-beta.6", "0.24.0-beta.5") > 0);
  assert.ok(compareReleaseVersions("1.0.0", "0.24.0-beta.5") > 0);
  assert.equal(compareReleaseVersions("v0.24.0-beta.5", "0.24.0-beta.5"), 0);
  assert.ok(compareReleaseVersions("0.23.0", "0.24.0-beta.5") < 0);
});

test("updater falls back to GitHub Releases API when feed manifest is absent", async () => {
  const makeAutoUpdater = () => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      logger: null,
      checkForUpdates: async () => {
        emitter.emit("checking-for-update");
        const err = new Error("No published versions on GitHub (404)");
        emitter.emit("error", err);
        throw err;
      },
      downloadUpdate: async () => [],
      quitAndInstall: () => {},
    });
  };

  // Case 1: repo has 0 releases (404) -> cleanly reports up-to-date
  const upToDateController = new AppUpdaterController({
    logger: noopLogger,
    send: () => {},
    currentVersion: "0.24.0-beta.5",
    isPackaged: true,
    platform: "darwin",
    autoUpdater: makeAutoUpdater(),
    fetchImpl: async () => new Response("Not Found", { status: 404 }),
  });
  const state1 = await upToDateController.check({ manual: true });
  assert.equal(state1.status, "up-to-date");
  assert.equal(state1.error, undefined);

  // Case 2: repo has newer stable release v0.25.0 -> reports available + release URL
  const availableController = new AppUpdaterController({
    logger: noopLogger,
    send: () => {},
    currentVersion: "0.24.0-beta.5",
    isPackaged: true,
    platform: "darwin",
    autoUpdater: makeAutoUpdater(),
    fetchImpl: async () =>
      Response.json({
        tag_name: "v0.25.0",
        body: "StarAI Desktop 0.25.0 release notes",
        html_url: "https://github.com/gexing521/StarAi-Desktop/releases/tag/v0.25.0",
        draft: false,
      }),
  });
  const state2 = await availableController.check({ manual: true });
  assert.equal(state2.status, "available");
  assert.equal(state2.availableVersion, "0.25.0");
  assert.equal(
    state2.releasesUrl,
    "https://github.com/gexing521/StarAi-Desktop/releases/tag/v0.25.0",
  );
  assert.equal(state2.mode, "manual");
});
