import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { en } from "../../../packages/i18n/src/locales/en/index.ts";
import { zhCN } from "../../../packages/i18n/src/locales/zh-CN/index.ts";
import { tr } from "../../../packages/i18n/src/locales/tr/index.ts";

const catalogs = { en, "zh-CN": zhCN, tr };

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "../..");

const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");
const panelSrc = readFileSync(join(desktopRoot, "electron/main/plugin-panel-host.ts"), "utf8");
const mainSrc = readFileSync(join(desktopRoot, "electron/main/index.ts"), "utf8");
const pageSrc = readFileSync(join(desktopRoot, "src/pages/PluginsPage.tsx"), "utf8");
const protocolSrc = readFileSync(join(repoRoot, "packages/shared/src/protocol.ts"), "utf8");

test("plugin runtime exposes gated high-risk host APIs", () => {
  for (const token of [
    "fs.write",
    "fs.delete",
    "fs.openDefault",
    "fs.reveal",
    "net.fetch",
    "shell.openExternal",
    "clipboard.read",
    "clipboard.write",
    "assertPermission",
  ]) {
    assert.match(runtimeSrc, new RegExp(token.replaceAll(".", "\\.")));
  }
});

test("native plugin notifications stay behind the existing notify permission", () => {
  for (const channel of [
    "ui.getNotificationPermission",
    "ui.requestNotificationPermission",
    "ui.showNativeNotification",
  ]) {
    assert.match(runtimeSrc, new RegExp(`\\"${channel}\\"`));
  }
  assert.match(runtimeSrc, /getNotificationPermission: async \(\) => \{/);
  assert.match(runtimeSrc, /requestNotificationPermission: async \(\) => \{/);
  assert.match(runtimeSrc, /showNativeNotification: async \(input/);
  assert.match(runtimeSrc, /this\.assertPermission\(loaded, "notify"\)/);
});

test("workspace deletion and panel operations stay bounded", () => {
  assert.match(runtimeSrc, /PANEL_SKILL_CHANNELS/);
  assert.match(runtimeSrc, /method: "panel.invoke"/);
  assert.match(runtimeSrc, /"fs.remove"/);
  assert.match(runtimeSrc, /recursive: false/);
  assert.match(runtimeSrc, /cannot remove the root itself/);
  // Deleting goes to the OS trash, so a delete this gate got wrong is still
  // recoverable; `rmSync` survives only as the fallback for a host that has no
  // trash to offer.
  assert.match(runtimeSrc, /this\.services\.trashItem\(full\)/);
  // A single-file remove in a loop empties a workspace as well as `rm -rf`;
  // the rolling window is what tells the two apart.
  assert.match(runtimeSrc, /MAX_DELETES_PER_WINDOW/);
});

test("the plugins page shows the file scope behind a file permission", () => {
  // A permission name says "may touch files"; only the scope says which ones,
  // so the row has to carry it or the user is approving a blank cheque.
  assert.match(pageSrc, /"fs\.write": "high"/);
  assert.match(pageSrc, /"fs\.read": "medium"/);
  assert.match(pageSrc, /function FsScopeChips\(/);
  assert.match(pageSrc, /t\("plugins\.fsAsksEachTime"\)/);
  assert.match(pageSrc, /t\("plugins\.legacyFsDowngraded"\)/);
  // The scope reaches the renderer from the registry, not from a second read
  // of the manifest, so an old record simply has no scope to show.
  const hostSrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins.rs"), "utf8");
  assert.match(hostSrc, /fs: manifest\.fs\.clone\(\)/);
  for (const catalog of Object.values(catalogs)) {
    assert.equal(typeof catalog.plugins.legacyFsDowngraded, "string");
    assert.equal(typeof catalog.plugins.fsMode.delete, "string");
    assert.equal(typeof catalog.plugins.permissions["fs.delete"], "string");
    assert.equal(typeof catalog.plugins.permissionHelp["fs.delete"], "string");
  }
});

test("plugin panels use sandboxed isolated host windows", () => {
  assert.match(panelSrc, /session\.fromPartition/);
  assert.match(panelSrc, /sandbox:\s*true/);
  assert.match(panelSrc, /nodeIntegration:\s*false/);
  assert.match(panelSrc, /plugin-panel\.js/);
});

test("plugins page includes marketplace install and auto-update controls", () => {
  assert.match(pageSrc, /tabMarket/);
  assert.match(pageSrc, /marketInstall/);
  assert.match(pageSrc, /applyAutoUpdates|marketApplyUpdates|checkUpdates/);
  assert.match(pageSrc, /permissionReview|grantedPermissions/);
});

test("plugins page refreshes installed update metadata when it opens", () => {
  assert.match(pageSrc, /useEffect\(\(\) => \{[\s\S]*api\.marketCheckUpdates\(false\)[\s\S]*refreshPlugins\(\)/);
  assert.match(
    mainSrc,
    /IPC\.invoke\.marketCheckUpdates[\s\S]*refreshRemote: payload\?\.refreshRemote \?\? true/,
  );
  assert.match(
    readFileSync(join(desktopRoot, "src/stores/app-store.ts"), "utf8"),
    /pluginRefreshInFlight[\s\S]*if \(pluginRefreshInFlight\) return pluginRefreshInFlight/,
  );
});

test("shared protocol declares marketplace and package install IPC", () => {
  for (const channel of [
    "pluginInstallFromPackage",
    "marketSearch",
    "marketInstall",
    "marketCheckUpdates",
    "marketApplyUpdates",
    "marketRefresh",
    "pluginOpenPanel",
    "pluginSetAutoUpdate",
  ]) {
    assert.match(protocolSrc, new RegExp(channel));
  }
});


test("plugins page can refresh the official marketplace repository", () => {
  assert.match(pageSrc, /marketRefresh|refreshMarket|refreshRemote/);
  assert.match(pageSrc, /pi-desktop-plugins|marketSource/);
});


test("marketplace detail pane renders readme changelog and versions", () => {
  assert.match(pageSrc, /marketGetDetail/);
  assert.match(pageSrc, /viewDetails|detailTitle|readmeMarkdown|versions/);
  assert.match(pageSrc, /installVersion|selectedVersion|changelog/);
});

// A publisher can list a version before uploading its package. The host then
// refuses the download, so the UI must not offer an install that can only end
// in PLUGIN_MARKET_INVALID.
test("marketplace blocks install for a version with no published package", () => {
  assert.match(pageSrc, /function versionInstallable\(/);
  assert.match(pageSrc, /const packagePending = item\.installable === false/);
  assert.match(pageSrc, /disabled=\{busyId === item\.id \|\| packagePending\}/);
  assert.match(pageSrc, /disabled=\{busyId === detail\.id \|\| detailPackagePending\}/);
  assert.match(pageSrc, /t\("plugins\.packagePending"\)/);
  assert.match(pageSrc, /t\("plugins\.packagePendingHint", \{/);

  const hostSrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins.rs"), "utf8");
  assert.match(hostSrc, /fn has_package_metadata\(version: &MarketVersion\) -> bool/);
  // `installable` is the single answer every install affordance reads, so it
  // has to cover every reason the host would refuse the download: no package
  // yet, a host too old for the version, or a package URL off the allowlist.
  assert.match(hostSrc, /installable: latest_version\s*\n\s*\.map\(\|version\| \{/);
  assert.match(hostSrc, /has_package_metadata\(version\)\s*\n\s*&& host_supports_version\(version\)/);
  assert.match(hostSrc, /package_host_allowed\(&version\.url, &catalog_url\)\.is_ok\(\)/);
  for (const catalog of Object.values(catalogs)) {
    assert.equal(typeof catalog.plugins.packagePending, "string");
    assert.equal(typeof catalog.plugins.packagePendingHint, "string");
  }
});

// Plugin source now lives in publisher repositories, so a package URL is no
// longer guaranteed to sit under one repository the project controls. The
// download boundary is what keeps a catalog entry from aiming a request
// anywhere it likes.
test("marketplace package downloads stay inside the host allowlist", () => {
  const hostSrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins.rs"), "utf8");
  assert.match(
    hostSrc,
    /const PACKAGE_HOST_ALLOWLIST: &\[&str\] = &\["github\.com", "githubusercontent\.com", "cnb\.cool"\]/,
  );
  assert.match(hostSrc, /fn package_host_allowed\(package_url: &str, catalog_url: &str\) -> Result<\(\)>/);
  // Refuse before the request leaves the machine, then hold the redirect
  // chain to the same rule: a release asset always redirects.
  assert.match(hostSrc, /package_host_allowed\(&info\.url, &catalog_url\)\?;/);
  assert.match(hostSrc, /download_url_guarded\(&info\.url, Some\(&catalog_url\)\)/);
  assert.match(hostSrc, /"--proto-redir"\.into\(\)/);
  assert.match(hostSrc, /"%\{url_effective\}"\.into\(\)/);
  assert.match(hostSrc, /must not embed credentials/);
});

// A withdrawn version is a distribution signal, not permission to disable
// software somebody is relying on.
test("a withdrawn version is never offered and never silently disabled", () => {
  const hostSrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins.rs"), "utf8");
  assert.match(hostSrc, /\.filter\(\|version\| !version\.yanked\)/);
  assert.match(hostSrc, /PLUGIN_MARKET_YANKED/);
  assert.match(hostSrc, /PLUGIN_HOST_TOO_OLD/);
  assert.match(hostSrc, /pub struct PluginYankNotice/);

  assert.match(pageSrc, /function versionWithdrawn\(/);
  assert.match(pageSrc, /const detailWithdrawn = versionWithdrawn\(activeVersion\)/);
  assert.match(pageSrc, /t\("plugins\.withdrawnHint", \{ version: installTarget \}\)/);
  for (const catalog of Object.values(catalogs)) {
    assert.equal(typeof catalog.plugins.withdrawn, "string");
    assert.equal(typeof catalog.plugins.withdrawnHint, "string");
    assert.equal(typeof catalog.plugins.withdrawnReason, "string");
  }
});

// The verified shield is a claim about a publisher, so it must come from the
// center rather than from text a publisher can write.
test("verified trust is not something a catalog entry can grant itself", () => {
  const hostSrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins.rs"), "utf8");
  assert.match(hostSrc, /fn resolve_trust\(&self, entry: &MarketCatalogEntry\) -> String/);
  assert.match(hostSrc, /"verified" if self\.is_official_market_source\(\) => "verified"/);
  assert.match(hostSrc, /"verified" => "community"/);

  assert.match(pageSrc, /function showsVerifiedBadge\(/);
  assert.match(pageSrc, /\{showsVerifiedBadge\(item\) \?/);
  assert.match(pageSrc, /\{showsVerifiedBadge\(detail\) \?/);
});
