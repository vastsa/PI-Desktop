/**
 * Developer-only settings destinations are retained in development builds
 * but omitted from packaged builds. Navigation, search, and stale-page
 * handling must honor the same visibility rules.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SETTINGS_NAV,
  isSettingsDestinationHidden,
  searchSettings,
  visibleSettingsNav,
} from "../src/lib/settings-search.ts";

const settingsPage = readFileSync(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const searchDialog = readFileSync(
  new URL("../src/components/SearchDialog.tsx", import.meta.url),
  "utf8",
);
const composer = readFileSync(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const composerToolbar = readFileSync(
  new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
  "utf8",
);

const liveVoiceSettings = readFileSync(
  new URL(
    "../src/features/settings/voice/LiveVoiceSettings.tsx",
    import.meta.url,
  ),
  "utf8",
);
const settingsPrimitives = readFileSync(
  new URL("../src/features/settings/primitives.tsx", import.meta.url),
  "utf8",
);

const identity = (key) => key;
const developerOnlyIds = SETTINGS_NAV.filter(entry => entry.developerOnly === true).map(entry => entry.id);

test("Live Voice is reachable in every build without developer mode", () => {
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      assert.ok(visibleSettingsNav(developerMode, includeDevelopmentOnly)
        .some((entry) => entry.id === "voice"));
      assert.equal(isSettingsDestinationHidden("voice", developerMode, includeDevelopmentOnly), false);
      for (const query of [
        "liveVoice.title",
        "liveVoice.enable",
        "liveVoice.provider",
        "liveVoice.adapters.codex-live.title",
        "liveVoice.adapters.gemini-live.title",
        "liveVoice.adapters.openai-realtime.title",
      ]) {
        assert.ok(searchSettings(query, identity, { developerMode, includeDevelopmentOnly })
          .some((hit) => hit.tab === "voice"));
      }
    }
  }
  // Voice is a regular Preferences destination now: no Experimental badge on
  // the rail row or the page title.
  assert.equal(
    SETTINGS_NAV.find((entry) => entry.id === "voice")?.experimentalBadgeKey,
    undefined,
  );
});

test("Cloud sync and Remote Hosts are gone from the settings index", () => {
  for (const id of ["sync", "remoteHosts"]) {
    assert.equal(SETTINGS_NAV.some((entry) => entry.id === id), false);
  }
  assert.equal(
    SETTINGS_NAV.some((entry) =>
      entry.keywordKeys.some(
        (key) =>
          key.startsWith("settings.configSync.") ||
          key.startsWith("settings.remoteHosts."),
      ),
    ),
    false,
  );
  for (const developerMode of [false, true]) {
    for (const includeDevelopmentOnly of [false, true]) {
      const options = { developerMode, includeDevelopmentOnly };
      assert.deepEqual(
        searchSettings("settings.nav.remoteHosts", identity, options),
        [],
      );
      assert.deepEqual(
        searchSettings("settings.configSync.connectionTitle", identity, options),
        [],
      );
    }
  }
});

test("developer mode retains the developer-only destinations in development", () => {
  const off = visibleSettingsNav(false).map((entry) => entry.id);
  const on = visibleSettingsNav(true).map((entry) => entry.id);

  for (const id of developerOnlyIds) {
    assert.equal(off.includes(id), false);
    assert.equal(on.includes(id), true);
  }
  assert.deepEqual(off, on.filter((id) => !developerOnlyIds.includes(id)));
  assert.deepEqual(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true).map((entry) => entry.id),
    developerOnlyIds,
  );
  assert.ok(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true)
      .every((entry) => entry.experimentalBadgeKey),
  );
});

test("packaged builds hide developer-only destinations", () => {
  const packaged = visibleSettingsNav(true, false).map((entry) => entry.id);
  for (const id of developerOnlyIds) {
    assert.equal(packaged.includes(id), false);
    assert.equal(isSettingsDestinationHidden(id, true, false), true);
  }
  assert.equal(isSettingsDestinationHidden("general", true, false), false);
});

test("settings search mirrors developer and packaged visibility", () => {
  assert.equal(searchSettings("settings", identity, { limit: 2 }).length, 2);
});

test("settings routes, global search, and composer use build visibility", () => {
  assert.match(settingsPage, /const includeDevelopmentOnly = import\.meta\.env\.DEV/);
  assert.match(settingsPage, /visibleSettingsNav\(developerMode, includeDevelopmentOnly\)/);
  assert.match(settingsPage, /isSettingsDestinationHidden\([\s\S]*includeDevelopmentOnly/);
  assert.match(settingsPage, /setSettingsTab\("general"\)/);
  assert.match(searchDialog, /includeDevelopmentOnly: import\.meta\.env\.DEV/);
  assert.match(composer, /useVoiceInput/);
  assert.doesNotMatch(composer, /VoiceOverlay|voiceEnabled/);
  assert.match(composerToolbar, /<LiveVoiceControls\b/);
  assert.doesNotMatch(composerToolbar, /VoiceMicButton|voicePhase|onVoiceToggle|onVoiceCancel/);
});

test("Live Voice keeps its Model configuration link on the card heading", () => {
  // The link belongs to the enable card's heading line, not to a floating
  // control inside the row stack.
  assert.match(settingsPrimitives, /settings-card-heading-with-action/);
  assert.match(settingsPrimitives, /action\?: ReactNode/);
  assert.match(
    liveVoiceSettings,
    /action=\{[\s\S]*className="settings-text-action"[\s\S]*settings\.configuration/,
  );
  assert.doesNotMatch(liveVoiceSettings, /live-voice-actions/);
});
