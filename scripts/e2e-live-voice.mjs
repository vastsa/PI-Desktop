#!/usr/bin/env node
// Built Electron + real Host + concrete Realtime adapter, using only a local TLS/audio fixture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertDesktopBuild, repositoryRoot } from "./e2e/boot.mjs";
import { Host, resolveHostBinary } from "./e2e/host.mjs";
import { launchLiveVoiceDesktop } from "./e2e/live-voice-desktop.mjs";
import { startLiveVoiceFixture } from "./e2e/live-voice-fixture.mjs";
import { waitFor } from "./e2e/wait.mjs";

if (process.argv.slice(2).some((arg) => arg !== "--fixture")) {
  throw new Error("Usage: node scripts/e2e-live-voice.mjs [--fixture]. Real accounts are never used by this suite.");
}
const root = repositoryRoot();
assertDesktopBuild(root);
const temp = await mkdtemp(join(tmpdir(), "pi-live-voice-e2e-"));
const dataDir = join(temp, "data");
const profile = join(temp, "profile");
const home = join(temp, "home");
const project = join(temp, "project");
const evidence = process.env.PI_LIVE_VOICE_EVIDENCE_DIR || join(temp, "evidence");
for (const path of [dataDir, profile, home, project, evidence]) await mkdir(path, { recursive: true });
const fixture = await startLiveVoiceFixture(root);
const host = new Host(resolveHostBinary(), dataDir);
let desktop;
const results = [];
const legacyVoice = { enabled: false, languages: ["en"] };
const pass = (name) => { results.push(name); console.log(`PASS ${name}`); };
const settings = () => desktop.invoke("settingsGet");
const status = () => desktop.invoke("liveVoiceStatus");
// The call chrome lives in the docked widget window now: bar controls and the
// bar's own failure text are asserted there, while the composer, preparation
// menu and details surface stay in the main window.
let widget = null;
const useWidget = async () => (widget = await desktop.useWidget());
// The widget window is a separate renderer that fetches the persisted language
// itself, so the bar is addressed by its configured-language aria-labels.
const clickBar = (label) => widget.clickSelector(`.live-voice-call-bar button[aria-label="${label}"]`);
// A released call can still leave the bar on screen: the widget keeps drawing a
// failed call's LIVE_* code until the user dismisses it, so "released" means no
// bar in an active state — the same predicate the in-app bar used before the
// call chrome moved into its own window.
const ACTIVE_CALL_BAR = ["connecting", "connected", "reconnecting", "stopping"]
  .map((state) => `.live-voice-call-bar[data-state="${state}"]`)
  .join(", ");
const waitIdle = () => waitFor(async () => {
  const call = (await status()).call;
  const mediaReleased = !call || (["ended", "failed"].includes(call.phase) && !call.microphoneActive);
  if (!mediaReleased) return false;
  if (!await desktop.evaluate("!!document.querySelector('.live-voice-control button')")) return false;
  return widget
    ? widget.evaluate(`!document.querySelector('${ACTIVE_CALL_BAR}')`)
    : true;
}, 12_000, "Live call media and Composer controls released");
const navVoice = () => desktop.clickText("Live voice", ".settings-nav-label");
const openSettings = async () => {
  await desktop.clickSelector('[data-nav="settings"]');
  await waitFor(() => desktop.evaluate("!!document.querySelector('.settings-nav')"), 10_000, "Settings navigation");
  await navVoice();
  await waitFor(() => desktop.evaluate("!!document.querySelector('.live-voice-settings')"), 10_000, "Live Voice settings");
};
const backToChat = () => desktop.clickSelector('[data-nav="back-to-app"]');
const startCall = async () => {
  const previousCallId = (await status()).call?.callId;
  await desktop.clickSelector(".live-voice-control button");
  await waitFor(() => desktop.evaluate("!!document.querySelector('.live-voice-preparation .live-voice-start')"),
    5_000, "Live Voice preparation menu");
  await desktop.clickSelector(".live-voice-preparation .live-voice-start");
  // Starting the call is what creates the widget window; the bar is asserted
  // there from now on.
  await useWidget();
  await waitFor(async () => {
    const live = await status();
    const alert = await widget.evaluate("!!document.querySelector('.live-voice-feedback[role=\"alert\"]')");
    const newCall = Boolean(live.call && live.call.callId !== previousCallId);
    return newCall && (live.call?.phase === "connected" || (alert && ["ended", "failed"].includes(live.call?.phase)));
  }, 30_000, "local Realtime connected or startup failed");
  // The widget window has no app shell and fetches the persisted language
  // itself, so its chrome must come up in the configured language rather than
  // in the OS locale.
  await waitFor(() => widget.evaluate(`document.documentElement.lang === 'en'
    && !!document.querySelector('.live-voice-call-bar button[aria-label="Call details"]')`),
  10_000, "widget chrome follows the configured language");
  assert.equal((await status()).call?.phase, "connected", "local Realtime call connected");
};
const openRealtimePicker = () => desktop.click(`
  [...document.querySelectorAll('.settings-card-block')]
    .find(el => el.textContent.includes('OpenAI Realtime compatible'))
    ?.querySelector('button[aria-label="Provider account"]')
`);
try {
  await host.start();
  await host.call("workspace.set", { path: project });
  await host.call("settings.set", { language: "en", developerMode: false, proxy: { mode: "direct" }, voice: legacyVoice });
  const created = await host.call("providers.create", {
    name: "Local Live Voice fixture",
    vendorKey: "openai",
    type: "openai_compatible",
    protocol: "openai_compatible",
    apiStyle: "chat_completions",
    authKind: "api_key",
    baseUrl: fixture.baseUrl,
    secretValue: "live-voice-e2e-key",
    models: [{ id: "live-voice-fixture" }],
  });
  const providerId = created.provider.id;
  await host.call("providers.update", { id: providerId, enabled: true });
  await host.stop();
  const launch = () => launchLiveVoiceDesktop({ root, dataDir, profile, home, certificate: fixture.certificate, evidence });
  desktop = await launch();
  const initial = await settings();
  assert.equal(initial.developerMode, false);
  assert.equal(initial.liveVoice?.enabled ?? false, false);
  assert.equal((await status()).enabled, false);
  assert.equal(fixture.stats.connections, 0);
  await openSettings();
  assert.equal(fixture.stats.connections, 0);
  await desktop.screenshot("live-voice-disabled.png");
  pass("ordinary users can reach Voice settings without starting capture");

  await desktop.input(".settings-search", "Live voice");
  await waitFor(() => desktop.evaluate("[...document.querySelectorAll('.settings-nav-label')].some(el => el.textContent.trim() === 'Live voice')"), 5_000, "Voice search match");
  await navVoice();
  await desktop.input(".settings-search", "");
  await openRealtimePicker();
  await desktop.clickText("Local Live Voice fixture", '[role="option"]');
  await waitFor(async () => (await settings()).liveVoice?.bindings.some((binding) => binding.providerId === providerId), 5_000, "provider binding persists");
  await desktop.input('.live-voice-settings input[aria-label="Model ID"]:not(:disabled)', "live-voice-fixture");
  assert.equal(await desktop.evaluate(`document.querySelector('.live-voice-settings input[aria-label="Model ID"]:not(:disabled)')?.value`),
    "live-voice-fixture", "model input replaces the existing value");
  await desktop.evaluate("document.activeElement?.blur()");
  await waitFor(async () => (await settings()).liveVoice?.bindings.some((binding) =>
    binding.providerId === providerId && binding.modelId === "live-voice-fixture"), 8_000, "model setting persists before enablement");
  await waitFor(() => desktop.evaluate("document.querySelector('button[aria-label=\"Enable Live voice\"]')?.disabled === false"),
    5_000, "Live Voice setting is ready to enable");
  await desktop.clickSelector('button[aria-label="Enable Live voice"]');
  await waitFor(async () => {
    const live = (await settings()).liveVoice;
    return live?.enabled === true && live.bindings.some((binding) => binding.modelId === "live-voice-fixture");
  }, 8_000, "Live configuration saved");
  assert.deepEqual((await settings()).voice, initial.voice);
  const configuredStatus = await status();
  assert.equal(configuredStatus.enabled, true);
  assert.equal(configuredStatus.bindings.find((binding) => binding.bindingId === configuredStatus.selectedBindingId)?.selectable,
    true, "the explicitly selected fixture provider is usable");
  assert.equal(fixture.stats.connections, 0);
  await desktop.screenshot("live-voice-configured.png");
  pass("normal settings search, explicit account binding and enablement preserve legacy voice settings");

  await backToChat();
  await startCall();
  assert.equal((await status()).call.muted, true);
  assert.equal((await status()).call.workBinding, undefined);
  await clickBar("Unmute microphone");
  await waitFor(() => fixture.stats.inputFrames > 0, 10_000, "synthetic microphone reaches the real WSS transport");
  await waitFor(async () => (await status()).call?.phase === "connected" && fixture.active() === 1,
    2_000, "uplink credit keeps the call and provider socket connected");
  fixture.reply();
  await clickBar("Call details");
  await waitFor(() => desktop.evaluate("document.querySelector('.live-voice-transcripts')?.textContent.includes('Local voice fixture reply.')"), 8_000, "provider transcript reaches Renderer");
  await desktop.screenshot("live-voice-connected.png");
  await desktop.clickSelector('.live-voice-details-popup button[aria-label="Close"]');
  await clickBar("Mute microphone");
  await waitFor(async () => (await status()).call?.muted === true, 5_000, "microphone muted");
  await delay(200);
  const mutedFrames = fixture.stats.inputFrames;
  await delay(300);
  assert.equal(fixture.stats.inputFrames, mutedFrames, "muting stops new provider audio frames");
  await clickBar("End call");
  await waitIdle();
  await waitFor(() => fixture.active() === 0, 5_000, "provider socket closes after hangup");
  assert.deepEqual((await desktop.invoke("sessionList")).sessions, [], "voice-only call creates no Agent session");
  pass("real Realtime socket, synthetic capture, playback/transcript, mute and hangup");

  fixture.holdNextSession();
  await desktop.clickSelector(".live-voice-control button");
  await desktop.clickSelector(".live-voice-preparation .live-voice-start");
  await waitFor(async () => (await status()).call?.phase === "connecting", 15_000, "delayed provider startup");
  // The widget window exists once the call view has been published; the bar is
  // the only place Cancel can be pressed.
  await useWidget();
  await clickBar("Cancel");
  await waitIdle();
  await waitFor(() => fixture.active() === 0, 5_000, "cancelled provider socket closes");
  await startCall();
  fixture.disconnect();
  await waitIdle();
  const disconnectedConnections = fixture.stats.connections;
  await delay(500);
  assert.equal(fixture.stats.connections, disconnectedConnections, "provider failure never auto-reconnects");
  await startCall();
  await clickBar("End call");
  await waitIdle();
  pass("cancelled startup and provider failure release resources for explicit reconnect");

  await desktop.close();
  desktop = await launch();
  // A relaunch has its own windows: the previous widget connection is gone.
  widget = null;
  const restored = await settings();
  assert.equal(restored.developerMode, false);
  assert.equal(restored.liveVoice.enabled, true);
  assert.equal(restored.liveVoice.bindings.find((binding) => binding.providerId === providerId)?.modelId, "live-voice-fixture");
  assert.equal((await status()).call, null);
  assert.equal(fixture.active(), 0);
  await openSettings();
  await desktop.clickSelector('button[aria-label="Enable Live voice"]');
  await waitFor(async () => (await settings()).liveVoice.enabled === false, 5_000, "disable persists");
  await desktop.screenshot("live-voice-restored-disabled.png");
  assert.deepEqual(fixture.errors, []);
  pass("restart restores opt-in settings but never resumes a call; disable remains available");
  await writeFile(join(evidence, "result.json"), JSON.stringify({
    candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    baseMain: execFileSync("git", ["rev-parse", "origin/main"], { cwd: root, encoding: "utf8" }).trim(),
    date: new Date().toISOString(), platform: process.platform, node: process.version,
    boundary: "built Electron, real preload/Main/Host, concrete Realtime GA adapter, local trusted TLS peer and synthetic audio",
    notRun: ["real provider accounts", "physical microphone and audible playback", "Live Work tool execution"],
    results, fixture: fixture.stats,
  }, null, 2));
  console.log(`Live Voice fixture E2E: ${results.length} journeys passed. Real-provider/device acceptance NOT RUN.`);
  console.log(`Evidence: ${evidence}`);
} catch (error) {
  await desktop?.screenshot("live-voice-failure.png").catch(() => undefined);
  const current = await desktop?.invoke("liveVoiceStatus").catch(() => null);
  const callFailure = current?.call
    ? {
      code: current.call.error?.code,
      stage: current.call.error?.stage,
      mediaRelease: current.call.mediaRelease,
    }
    : null;
  console.error(`Live Voice E2E failed: ${error.message}; phase=${current?.call?.phase ?? "none"}; callFailure=${JSON.stringify(callFailure)}; fixture=${JSON.stringify({ ...fixture.stats, active: fixture.active(), errors: fixture.errors })}`);
  throw error;
} finally {
  await desktop?.close();
  await host.stop();
  await fixture.close();
}
