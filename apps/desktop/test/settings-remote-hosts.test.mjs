/**
 * Settings ▸ Remote Hosts page contract.
 *
 * Guards the compact inventory + on-demand Add (SSH/Pair) forms: no
 * instructional copy, both forms are hidden until selected, and the
 * destination is marked Experimental on the rail and page title.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { loadStylesSync } from "./helpers/styles.mjs";
import { readSettingsSourceSync } from "./helpers/source-contracts.mjs";

const page = readFileSync(
  new URL("../src/components/settings/RemoteHostsPage.tsx", import.meta.url),
  "utf8",
);
const settingsNav = readFileSync(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const settings = readSettingsSourceSync();
const styles = loadStylesSync();

function cssRule(selector) {
  const from = styles.indexOf(`\n${selector} {`);
  assert.ok(from >= 0, `${selector} rule missing`);
  return styles.slice(from, styles.indexOf("}", from));
}

test("remote hosts puts Add actions before the inventory and opens dialog forms", () => {
  assert.match(page, /useState<AddMode \| null>\(null\)/);
  assert.doesNotMatch(page, /role="tablist"/);
  const actionsIndex = page.indexOf('className="settings-remote-host-add-actions"');
  const inventoryIndex = page.indexOf('className="settings-remote-host-list"');
  assert.ok(actionsIndex >= 0 && actionsIndex < inventoryIndex, "Add actions should precede the inventory");
  for (const mode of ["ssh", "pair"]) {
    assert.ok(page.includes(`id="remote-host-add-${mode}"`));
    assert.ok(page.includes('aria-haspopup="dialog"'));
    assert.ok(page.includes(`onClick={() => setAddMode("${mode}")}`));
    assert.ok(page.includes(`id="remote-host-add-panel-${mode}"`));
    assert.ok(page.includes(`hidden={addMode !== "${mode}"}`));
  }
  assert.match(page, /portalOverlay\(/);
  assert.match(page, /className="dialog settings-remote-host-add-dialog"/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /aria-labelledby="settings-remote-host-add-dialog-title"/);
  assert.match(page, /event.key === "Escape"/);
  assert.match(page, /pendingAddFocus\.current = addMode === "pair"/);
  assert.match(page, /pendingAddFocus\.current = null;\s+trigger\.focus\(\)/);
  assert.match(page, /onClick=\{closeAddForm\}/);
  assert.match(page, /setSshForm\(EMPTY_SSH_FORM\)/);
  assert.doesNotMatch(page, /settings-remote-host-add-shell/);
  assert.match(page, /api\.bootstrapRemoteHost\(/);
  assert.match(page, /api\.pairRemoteHost\(/);
  assert.match(page, /api\.listRemoteHosts\(/);
  assert.match(page, /api\.removeRemoteHost\(/);

  assert.match(cssRule(".settings-remote-host-add-dialog"), /width:\s*min\(100%, 640px\)/);
  assert.match(cssRule(".settings-remote-host-add-panel[hidden]"), /display:\s*none/);
  assert.match(cssRule(".settings-remote-host-card"), /background:\s*var\(--ds-tile\)/);
  assert.match(cssRule(".settings-remote-host-name"), /font-size:\s*var\(--text-md-plus\)/);
});

test("remote-host dialog form leaves space for focused input rings", () => {
  const formRule = cssRule(".settings-remote-host-add-dialog .settings-remote-host-form");
  assert.match(formRule, /overflow-x:\s*hidden/);
  assert.match(formRule, /padding:\s*2px(?:\s+2px){0,3}\s*;/);
});

test("remote host cards open project creation instead of a session workbench", () => {
  assert.match(page, /openProject\(\{ remoteHostKey: host\.hostKey \}\)/);
  assert.match(page, /remoteT\("newProject"\)/);
  assert.doesNotMatch(page, /RemoteHostSessions|selectedHost|remoteT\("sessions"\)/);
});

test("SSH key mode selects a local identity file instead of accepting a typed path", () => {
  const start = page.indexOf('<Field label={t("settings.remoteHosts.sshIdentityFile")}>');
  const end = page.indexOf(") : (", start);
  assert.ok(start >= 0 && end > start, "key-auth identity field should exist");
  const identityField = page.slice(start, end);
  const displayInput = identityField.match(/<Input[\s\S]*?\/>/)?.[0];
  assert.ok(displayInput, "selected path should use the shared Input primitive");
  assert.match(displayInput, /readOnly/);
  assert.doesNotMatch(displayInput, /onChange=/);
  assert.match(identityField, /sshIdentityFileChoose/);
  assert.match(identityField, /sshIdentityFileClear/);
  assert.match(identityField, /type="file"/);
  assert.match(identityField, /onChange={handleSshIdentityFileChange}/);
  assert.match(page, /api\.getDroppedFilePath\(file\)/);
  assert.match(page, /input\.value = ""/);
  assert.match(page, /if \(!file\) return/);
  assert.match(page, /const identityFile = sshForm\.identityFile;/);
  assert.match(page, /sshIdentityFileError/);
  assert.match(
    cssRule(".settings-remote-host-identity-file"),
    /grid-template-columns: minmax\(0, 1fr\) auto auto/,
  );
  assert.match(cssRule(".settings-remote-host-identity-file-input"), /display: none/);
});

test("remote hosts omits instructional copy", () => {
  assert.doesNotMatch(page, /role="note"/);
  assert.doesNotMatch(page, /settings-row-desc/);
  assert.doesNotMatch(page, /hint=\{/);
  assert.doesNotMatch(page, /settings\.remoteHosts\.(overview|sshBody|pairBody|emptyBody)/);
  assert.doesNotMatch(page, /<SettingsCard title=\{t\("settings\.remoteHosts\.listTitle"\)\}/);
});

test("the remote-hosts destination is marked experimental", () => {
  assert.match(
    settingsNav,
    /\{\s*id: "remoteHosts",[\s\S]*?experimentalBadgeKey: "settings\.remoteHosts\.experimental",/,
  );
  assert.match(settings, /item\.experimentalBadgeKey \? \(/);
  assert.match(settings, /activeNavItem\?\.experimentalBadgeKey \? \(/);
  assert.match(settings, /className="settings-nav-experimental"/);
  assert.match(cssRule(".settings-nav-experimental"), /font-size:\s*var\(--text-2xs\)/);
  assert.doesNotMatch(page, /EXPERIMENTAL_FEATURES/);
  assert.doesNotMatch(page, /experimentalLan/);
  assert.doesNotMatch(page, /experimentalGateway/);
  assert.doesNotMatch(page, /SettingsCard/);
});

test("remote host inventory renders non-binary connection states with localized labels", () => {
  assert.match(page, /statusConnecting/);
  assert.match(page, /statusReconnecting/);
  assert.match(page, /statusActionRequired/);
  assert.match(page, /statusOffline/);
});
