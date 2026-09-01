import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadStyles } from "./helpers/styles.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [
  protocolSource,
  typesSource,
  updaterSource,
  mainSource,
  menuSource,
  apiSource,
  bannerSource,
  releaseNotesDialogSource,
  settingsSource,
  appSource,
  stylesSource,
  pkgSource,
  releaseWorkflowSource,
  enSource,
  zhSource,
  changelogSource,
] = await Promise.all([
  read("../../../packages/shared/src/protocol.ts"),
  read("../../../packages/shared/src/types.ts"),
  read("../electron/main/updater.ts"),
  read("../electron/main/index.ts"),
  read("../electron/main/application-menu.ts"),
  read("../src/lib/api.ts"),
  read("../src/components/UpdateBanner.tsx"),
  read("../src/components/ReleaseNotesDialog.tsx"),
  read("../src/pages/SettingsPage.tsx"),
  read("../src/App.tsx"),
  loadStyles(),
  read("../package.json"),
  read("../../../.github/workflows/release.yml"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
  read("../../../packages/i18n/src/locales/zh-CN/index.ts"),
  read("../../../packages/shared/src/changelog.ts"),
]);

test("update IPC channels are declared and whitelisted for the preload bridge", () => {
  for (const channel of [
    "updatesGetState",
    "updatesCheck",
    "updatesDownload",
    "updatesInstall",
    "updatesOpenReleases",
    "updatesState",
  ]) {
    assert.match(protocolSource, new RegExp(`${channel}:`), channel);
  }
  // The whitelist derives from the IPC map, so declaring is allowing.
  assert.match(protocolSource, /\.\.\.Object\.values\(IPC\.invoke\)/);
  assert.match(protocolSource, /\.\.\.Object\.values\(IPC\.event\)/);
  assert.match(typesSource, /export type UpdateState = \{/);
  assert.match(
    typesSource,
    /releaseNotes\?: string/,
    "UpdateState carries dual-locale product notes from Main",
  );
});

test("main process registers update handlers and the auto-check lifecycle", () => {
  for (const channel of [
    "IPC.invoke.updatesGetState",
    "IPC.invoke.updatesCheck",
    "IPC.invoke.updatesDownload",
    "IPC.invoke.updatesInstall",
    "IPC.invoke.updatesOpenReleases",
  ]) {
    assert.ok(mainSource.includes(channel), channel);
  }
  assert.match(mainSource, /new AppUpdaterController\(/);
  assert.match(mainSource, /isPackaged:\s*!isDevelopmentBuild/);
  assert.match(mainSource, /updater\.startAutoCheck\(\)/);
  assert.match(mainSource, /updater\.dispose\(\)/);
});

test("updater gates delivery mode by platform, packaging and signature reality", () => {
  // Unsigned macOS builds must not attempt in-app installs (Squirrel.Mac
  // rejects them); dev builds are disabled outright.
  assert.match(updaterSource, /if \(!isPackaged\) return "disabled"/);
  assert.match(updaterSource, /win32.*in-app|in-app.*win32/s);
  assert.match(updaterSource, /APPIMAGE/);
  assert.match(updaterSource, /autoInstallOnAppQuit = true/);
  assert.match(
    updaterSource,
    /allowPrerelease = false/,
    "prerelease installs must still track the stable GitHub latest release",
  );
  assert.match(updaterSource, /quitAndInstall/);
  assert.match(
    updaterSource,
    /state\.status === "downloaded"[\s\S]*return this\.state/,
  );
  assert.match(updaterSource, /autoUpdater\.on\("error"/);
  assert.match(
    updaterSource,
    /github\.com\/vastsa\/PI-Desktop\/releases/,
    "releases fallback URL",
  );
  assert.match(
    updaterSource,
    /formatChangelogNotes/,
    "in-app dual-locale notes attach from the shared changelog catalog",
  );
  assert.match(
    updaterSource,
    /releaseNotes: this\.notesFor/,
    "discovery and download events attach releaseNotes on UpdateState",
  );
  assert.match(
    updaterSource,
    /refreshReleaseNotes/,
    "locale changes re-resolve notes without a new feed check",
  );
});

test("renderer exposes the updates API, banner and settings row", () => {
  assert.match(apiSource, /updatesGetState:/);
  assert.match(apiSource, /updatesCheck:/);
  assert.match(apiSource, /updatesInstall:/);
  assert.match(apiSource, /onUpdateState:/);
  assert.match(bannerSource, /updates\.restart/);
  assert.match(bannerSource, /updates\.viewRelease/);
  assert.match(bannerSource, /updates\.whatsNew/);
  assert.match(bannerSource, /releaseNotes/);
  assert.match(bannerSource, /availableVersion}:\$\{update\.status/);
  assert.match(bannerSource, /className="update-notice"/);
  assert.match(bannerSource, /role="progressbar"/);
  assert.match(settingsSource, /<UpdatesRow currentVersion=/);
  assert.match(settingsSource, /update-settings-notes/);
  assert.match(settingsSource, /updates\.whatsNew/);
  assert.match(settingsSource, /updates\.releaseNotes/);
  assert.match(settingsSource, /<ReleaseNotesDialog/);
  assert.match(releaseNotesDialogSource, /CHANGELOG\[locale\]/);
  assert.match(releaseNotesDialogSource, /role="dialog"/);
  assert.match(releaseNotesDialogSource, /aria-modal="true"/);
  assert.match(releaseNotesDialogSource, /data-release-version/);
  assert.match(releaseNotesDialogSource, /event\.key === "Escape"/);
  assert.match(
    appSource,
    /<section className="main-pane">[\s\S]*?<UpdateBanner \/>/,
    "chat update notice is anchored inside the main pane",
  );
  assert.match(
    stylesSource,
    /\.update-notice \{[\s\S]*?position: absolute;[\s\S]*?top: 54px;/,
  );
  assert.doesNotMatch(
    bannerSource,
    /fixed bottom-4 right-4/,
    "update notice must not occupy the composer edge",
  );
  assert.match(appSource, /case "checkForUpdates"/);
});

test("check-for-updates is reachable from the application menu", () => {
  assert.match(protocolSource, /"checkForUpdates",/);
  assert.match(menuSource, /checkForUpdates/);
  for (const source of [enSource, zhSource]) {
    assert.match(source, /checkForUpdates:/);
    assert.match(source, /updates: \{/);
    for (const key of [
      "upToDate",
      "downloading",
      "downloaded",
      "restart",
      "whatsNew",
      "releaseNotes",
      "closeReleaseNotes",
      "currentBadge",
      "availableBadge",
    ]) {
      assert.match(source, new RegExp(`${key}:`), key);
    }
  }
});

test("packaging publishes an electron-updater feed for GitHub Releases", () => {
  const pkg = JSON.parse(pkgSource);
  assert.ok(pkg.dependencies["electron-updater"], "electron-updater dependency");
  assert.equal(pkg.build.publish[0].provider, "github");
  assert.equal(pkg.build.publish[0].owner, "vastsa");
  assert.equal(pkg.build.publish[0].repo, "PI-Desktop");
  const macTargets = pkg.build.mac.target.map((entry) => entry.target);
  assert.ok(macTargets.includes("zip"), "mac zip target (Squirrel.Mac feed)");
  // electron-builder must never self-publish (implicit tag publishing would
  // fail on the missing token and race the softprops release step).
  for (const script of ["dist", "dist:mac", "dist:win", "dist:linux"]) {
    assert.match(pkg.scripts[script], /--publish never/, script);
  }
  assert.equal(pkg.build.linux.executableName, "pi-desktop");
  // Scoped package name is not a valid deb package/file name.
  assert.equal(pkg.build.deb.packageName, "pi-desktop");
  assert.ok(!pkg.build.deb.artifactName.includes("${name}"), "deb artifactName");
  // GitHub asset URLs mangle spaces; keep the NSIS artifact name space-free.
  assert.equal(pkg.build.nsis.artifactName, "PI-Desktop-Setup-${version}.${ext}");
  // The upload step must carry every updater feed, and the release publishes
  // all platforms unfiltered (D126/D285).
  assert.match(releaseWorkflowSource, /release\/\*\.zip/);
  assert.match(releaseWorkflowSource, /release\/latest\*\.yml/);
  assert.match(releaseWorkflowSource, /files: dist\/\*/);
});

test("shared dual-locale changelog is the in-app notes source of truth", () => {
  assert.match(changelogSource, /export const CHANGELOG/);
  assert.match(changelogSource, /formatChangelogNotes/);
  assert.match(changelogSource, /"zh-CN"/);
  assert.match(changelogSource, /version: "0\.2\.7"/);
  assert.match(
    mainSource,
    /getLocale:\s*\(\)\s*=>\s*updaterLocale/,
    "Main supplies product locale to the updater for note selection",
  );
  assert.match(mainSource, /updater\.refreshReleaseNotes\(\)/);
  assert.match(stylesSource, /\.update-notice-notes/);
  assert.match(stylesSource, /\.update-settings-notes/);
});
