import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const model = await import("../src/features/startup/app-overlay-model.ts");
const { createInteractionSlice } = await import("../src/stores/slices/interaction-slice.ts");

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("only one app overlay shows, by priority guide > announcement > settings", () => {
  const all = { guide: true, announcement: true, settings: true };
  assert.equal(model.resolveAppOverlay(all), "guide");
  assert.equal(model.resolveAppOverlay({ ...all, guide: false }), "announcement");
  assert.equal(
    model.resolveAppOverlay({ guide: false, announcement: false, settings: true }),
    "settings",
  );
  assert.equal(
    model.resolveAppOverlay({ guide: false, announcement: false, settings: false }),
    null,
  );
});

test("startup guide: new users configure a model, returning users learn the launcher", () => {
  assert.deepEqual(
    model.planStartupGuide({ completedVersion: 0, hasUsableModel: false }),
    { audience: "new", steps: ["model", "launcher"] },
  );
  assert.deepEqual(
    model.planStartupGuide({ completedVersion: 0, hasUsableModel: true }),
    { audience: "returning", steps: ["launcher"] },
  );
  assert.equal(
    model.planStartupGuide({
      completedVersion: model.STARTUP_GUIDE_VERSION,
      hasUsableModel: false,
    }),
    null,
    "a finished or skipped guide version never returns",
  );
});

test("announcement is off by default and shows at most once per release", () => {
  const release = { id: "0.24.0" };
  const empty = { shownIds: [] };
  assert.equal(model.shouldShowAnnouncement(null, empty), false, "off by default");
  assert.equal(model.shouldShowAnnouncement(release, empty), true);
  const shown = model.announcementShown(release, empty);
  assert.equal(model.shouldShowAnnouncement(release, shown), false, "closed means never again");
  assert.strictEqual(model.announcementShown(release, shown), shown, "recording twice is a no-op");
  assert.equal(model.shouldShowAnnouncement({ id: "0.25.0" }, shown), true, "next release starts fresh");
  let history = empty;
  for (let i = 0; i < 30; i += 1) history = model.announcementShown({ id: `v${i}` }, history);
  assert.equal(history.shownIds.length, 20, "history stays bounded");
});

test("a replayed guide follows the user's current model state", () => {
  assert.deepEqual(model.startupGuideFor(true).steps, ["launcher"]);
  assert.deepEqual(model.startupGuideFor(false).steps, ["model", "launcher"]);
});

test("announcement locale fallback", () => {
  assert.deepEqual(model.announcementLocaleCandidates("zh-TW"), ["zh-TW", "zh", "en"]);
  assert.deepEqual(model.announcementLocaleCandidates("en"), ["en"]);
  assert.deepEqual(model.announcementLocaleCandidates(undefined), ["en"]);
});

function harness() {
  let state = {
    page: "chat",
    activeSessionId: "s1",
    settingsOpen: false,
    settingsTab: "appearance",
    settingsAnchor: null,
    settingsTabNonce: 0,
    navStack: [{ page: "chat", sessionId: "s1" }],
    navIndex: 0,
  };
  const actions = createInteractionSlice({
    get: () => state,
    set: (update) => {
      state = { ...state, ...(typeof update === "function" ? update(state) : update) };
    },
    runtime: { beginNavigationIntent: () => 1 },
    interactionRuntime: {},
  });
  state = { ...state, ...actions };
  return { get: () => state };
}

test("Settings is a dialog over the current page, not a route", () => {
  const h = harness();
  h.get().openSettings();
  assert.equal(h.get().settingsOpen, true);
  assert.equal(h.get().page, "chat", "the page underneath stays");
  assert.equal(h.get().navStack.length, 1, "opening Settings records no history");

  h.get().setSettingsTab("about");
  assert.equal(h.get().settingsTab, "about");
  assert.equal(h.get().settingsTabNonce, 1);

  h.get().setSettingsAnchor("updates.title");
  h.get().closeSettings();
  assert.equal(h.get().settingsOpen, false);
  assert.equal(h.get().settingsAnchor, null, "a pending anchor does not outlive the dialog");

  h.get().openSettings("shortcuts");
  assert.equal(h.get().settingsOpen, true);
  assert.equal(h.get().settingsTab, "shortcuts");
  h.get().setPage("plugins");
  assert.equal(h.get().settingsOpen, false, "navigating to a page dismisses Settings");
  assert.equal(h.get().page, "plugins");
});

test("the shell mounts one overlay host and Settings no longer replaces the shell", async () => {
  const [shell, host, runtime] = await Promise.all([
    read("../src/features/app/AppShell.tsx"),
    read("../src/features/startup/AppOverlayHost.tsx"),
    read("../src/features/app/useAppShellRuntime.tsx"),
  ]);
  assert.match(shell, /<AppOverlayHost active=\{!showSplash\} \/>/);
  assert.doesNotMatch(shell, /page === "settings"/);
  assert.doesNotMatch(runtime, /"settings"/);
  assert.match(host, /resolveAppOverlay\(/);
  assert.match(host, /<SettingsDialog onClose=\{closeSettings\} \/>/);
});

test("the startup guide embeds the shared Settings destination", async () => {
  const [guide, settingsPage] = await Promise.all([
    read("../src/features/startup/StartupGuideDialog.tsx"),
    read("../src/features/settings/SettingsPage.tsx"),
  ]);
  assert.match(guide, /<SettingsDestinationContent tab="agent" \/>/);
  assert.match(settingsPage, /<SettingsDestinationContent tab=\{tab\} tabHidden=\{tabHidden\} \/>/);
});

test("guide replay and launcher detection are wired end to end", async () => {
  const [host, about, guide, launcher] = await Promise.all([
    read("../src/features/startup/AppOverlayHost.tsx"),
    read("../src/features/settings/pages/AboutSettings.tsx"),
    read("../src/features/startup/StartupGuideDialog.tsx"),
    read("../electron/main/bootstrap/launcher.ts"),
  ]);
  // Settings → About replays the guide without touching the first-launch marker.
  assert.match(about, /useStartupGuideRequest\.getState\(\)\.request\(\)/);
  assert.match(host, /if \(guide\?\.source === "auto"\) saveStartupGuideCompletedVersion/);
  // Keycaps light up when the launcher actually opens.
  assert.match(guide, /api\.onPluginLauncherShown\(\(\) => setPressed\(true\)\)/);
  assert.match(guide, /keybindingMatchesEvent\(binding, event, platform\)/);
  assert.match(launcher, /mainWindow\.webContents\.send\(IPC\.event\.pluginLauncherShown\)/);
});

test("the chat home no longer carries the first-run checklist", async () => {
  const chat = await read("../src/components/ChatSurface.tsx");
  assert.doesNotMatch(chat, /OnboardingChecklist/);
});
