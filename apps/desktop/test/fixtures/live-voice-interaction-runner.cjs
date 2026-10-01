const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const assert = require("node:assert/strict");

app.setName("PI Live Voice Interaction Test");
const results = [];
const deniedRequests = [];
let permissionRequests = 0;
let win;
const artifact = (name) => join(process.env.PI_LIVE_VOICE_ARTIFACT_DIR, name);
const prep = '[role="dialog"][aria-label="Prepare Live voice"]';
const details = '[role="dialog"][aria-label="Call details"]';
const bar = ".live-voice-call-bar";
const button = (name, scope = "body") => `ui.named('button', ${JSON.stringify(name)}, ${JSON.stringify(scope)})`;
const checkbox = (name) => `ui.named('input[type="checkbox"]', ${JSON.stringify(name)}, ${JSON.stringify(prep)})`;
const evaluate = (code) => win.webContents.executeJavaScript(code);
const frame = () => evaluate(`(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await Promise.all(document.getAnimations()
    .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {})));
})()`);

async function wait(name, predicate) {
  await evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 10000;
    function poll() {
      try {
        const s = window.liveVoiceFixture?.inspect();
        const ui = window.voiceTest;
        if (${predicate}) return resolve(true);
        if (performance.now() > deadline) return reject(new Error(${JSON.stringify(name)} + ': ' + JSON.stringify({
          snapshot: s,
          dialogs: [...document.querySelectorAll('[role="dialog"]')].map(element => ({ label: element.getAttribute('aria-label'), visible: ui?.visible(element) })),
          triggers: [...document.querySelectorAll('button[aria-label="Live voice"]')].map(element => ({ expanded: element.getAttribute('aria-expanded'), visible: ui?.visible(element) })),
        })));
        requestAnimationFrame(poll);
      } catch (error) { reject(error); }
    }
    poll();
  })`);
}
async function check(name, predicate) {
  await wait(name, predicate);
  results.push({ name, ok: true });
  console.log(`PASS ${name}`);
}
async function capture(name) {
  if (process.env.PI_LIVE_VOICE_CAPTURE_UI !== "1") return;
  await frame();
  writeFileSync(artifact(`${name}.png`), (await win.webContents.capturePage()).toPNG());
}
async function click(expression) {
  win.focus();
  win.webContents.focus();
  const point = await evaluate(`(() => {
    const ui = window.voiceTest;
    const element = ${expression};
    if (!element || element.disabled) throw new Error('Missing or disabled input: ' + ${JSON.stringify(expression)});
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    if (!ui.visible(element) || !element.contains(document.elementFromPoint(x, y))) throw new Error('Input is not reachable: ' + ${JSON.stringify(expression)});
    return { x, y };
  })()`);
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  await frame();
}
async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await frame();
}
async function selectOption(expression, value) {
  const result = await evaluate(`(() => {
    try {
      const ui = window.voiceTest;
      const element = ${expression};
      if (!element || element.disabled) throw new Error('Missing or disabled select: ' + ${JSON.stringify(expression)});
      element.focus();
      element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    } catch (error) { return { ok: false, error: String(error) }; }
  })()`);
  if (!result.ok) throw new Error(result.error);
  await frame();
}

async function fresh(enabled = true) {
  await win.loadURL(process.env.PI_LIVE_VOICE_FIXTURE_URL);
  if (!win.isVisible()) win.show();
  win.focus();
  win.webContents.focus();
  await wait("fixture loaded", "s?.snapshot.status && document.querySelector('[aria-label=\"Fixture shell navigation\"]')");
  await evaluate(`window.voiceTest = {
    visible(element) {
      if (!element || element.closest('[hidden]')) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    },
    name(element) {
      const labelled = element.getAttribute('aria-labelledby');
      return (element.getAttribute('aria-label') || (labelled && labelled.split(/\\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' '))
        || (element.labels?.length ? [...element.labels].map(label => label.textContent).join(' ') : element.textContent)).trim().replace(/\\s+/g, ' ');
    },
    all(selector, name, scope = 'body') {
      return [...(document.querySelector(scope)?.querySelectorAll(selector) ?? [])]
        .filter(element => this.visible(element) && (name === undefined || this.name(element) === name));
    },
    named(selector, name, scope = 'body') {
      const matches = this.all(selector, name, scope);
      if (matches.length > 1) throw new Error('Ambiguous accessible name: ' + name);
      return matches[0];
    },
    state(value) { return this.visible(document.querySelector('.live-voice-call-bar[data-state="' + value + '"]')); },
    dialog(selector) { return this.visible(document.querySelector(selector)); },
  }; true`);
  if (enabled) {
    await evaluate("window.liveVoiceFixture.configure({ enabled: true })");
    await wait("Live Voice enabled", `s.snapshot.status.enabled && ${button("Live voice")}`);
  }
  await frame();
}
const noMedia = "['prepare','connect','getUserMedia','audioContext'].every(name => s.counts[name] === 0)";
const noDialog = "document.querySelectorAll('[role=dialog]').length === 0";
async function openPreparation() {
  await click(button("Live voice"));
  await wait("preparation open", `ui.dialog(${JSON.stringify(prep)})`);
}
async function start() {
  await openPreparation();
  await click(button("Start Live voice", prep));
}
async function connected() {
  await wait("connected call", `ui.state('connected') && !s.snapshot.starting && s.snapshot.call?.phase === 'connected'`);
}
async function clean() {
  await check("no unexpected IPC, browser errors, or surviving local media",
    "s.requests.unexpected.length === 0 && s.errors.length === 0 && s.tracks.every(track => track.readyState === 'ended') && s.contexts.every(context => context.state === 'closed') && s.peers.every(peer => peer.connectionState === 'closed') && document.querySelectorAll('audio').length === 0");
}

async function preparationScenario() {
  await fresh(false);
  await check("disabled Live Voice has neither Live nor work icons",
    `ui.all('button', undefined, '[data-fixture-composer]').length === 0 && !s.widget.visible && ${noMedia}`);
  await evaluate("window.liveVoiceFixture.configure({ enabled: true })");
  await check("enabling exposes exactly one idle trigger",
    `s.snapshot.status.enabled && ui.all('button', undefined, '[data-fixture-composer]').length === 1 && ${button("Live voice")}`);
  await openPreparation();
  await check("preparation carries no explanatory prose around its controls",
    `(() => {
      const text = document.querySelector(${JSON.stringify(prep)})?.textContent ?? '';
      return !text.includes('The current Composer session is the default') && !text.includes('up to six recent plain-text') &&
        text.includes('Selected fixture account') && !${button("Allow work requests", prep)} &&
        ${checkbox("Share limited recent conversation context")}?.checked === false && ${noMedia};
    })()`);
  await click(button("Close", prep));
  await check("closing preparation acquires no media", `${noDialog} && ${noMedia}`);
  await openPreparation();
  await key("Escape");
  await check("Escape dismisses preparation without starting", `${noDialog} && ${noMedia}`);
  await openPreparation();
  await click(button("Fixture chat route"));
  await check("outside click dismisses preparation without starting", `${noDialog} && ${noMedia}`);
  await openPreparation();
  await click(button("Fixture toggle composer visibility"));
  await check("hidden composer suppresses the production preparation portal",
    `${noDialog} && !${button("Live voice")} && document.querySelector('[data-fixture-composer]')?.hidden && ${noMedia}`);
  await click(button("Fixture toggle composer visibility"));
  await evaluate("window.liveVoiceFixture.configure({ selectedAvailable: false })");
  await wait("selected binding unavailable", "s.snapshot.status.bindings[0].selectable === false");
  await openPreparation();
  await check("unavailable exact selection explains failure despite another ready account",
    `${button("Start Live voice", prep)}?.disabled && document.querySelector(${JSON.stringify(prep)})?.textContent.includes('Credentials missing') && s.snapshot.status.bindings[1].selectable && ${noMedia}`);
  await capture("preparation-unavailable");
  await key("Escape");
  await clean();
}

async function cancellationScenario() {
  await fresh();
  await evaluate("['connect','end','released'].forEach(name => window.liveVoiceFixture.hold(name))");
  await start();
  await check("explicit Start defaults muted and shows compact connecting with Cancel",
    `ui.state('connecting') && ${button("Cancel", bar)} && ${noDialog} && s.counts.connect === 1 && s.counts.prepare === 1 && s.counts.getUserMedia === 1 && s.counts.audioContext === 1 && s.requests.prepare[0].initialMuted === true && s.requests.prepare[0].workTarget?.workSessionId === 'fixture-session-1' && s.requests.prepare[0].shareSelectedSessionContext === false && !('contextEnabled' in s.requests.prepare[0].workTarget) && s.tracks.every(track => !track.enabled)`);
  await click(button("Cancel", bar));
  await check("Cancel enters stopping while deferred release remains pending",
    `ui.state('stopping') && s.snapshot.stopping && s.counts.released === 1 && s.tracks.every(track => track.readyState === 'ended') && !${button("Live voice")}`);
  await capture("call-stopping");
  await evaluate("window.liveVoiceFixture.release('connect'); window.liveVoiceFixture.release('end')");
  await check("terminal host result cannot hide pending renderer release",
    `s.snapshot.call?.phase === 'ended' && s.snapshot.stopping && ui.state('stopping')`);
  await evaluate("window.liveVoiceFixture.release('released')");
  await check("cancel finishes neutrally without a reconnect",
    `!s.snapshot.starting && !s.snapshot.stopping && !s.snapshot.errorCode && ${button("Live voice")} && !ui.visible(document.querySelector(${JSON.stringify(bar)})) && s.counts.prepare === 1 && s.counts.connect === 1`);
  await clean();
}

async function connectedScenario() {
  await fresh();
  await start();
  await connected();
  await check("connected call starts muted with no details dialog", `${button("Unmute microphone", bar)} && s.snapshot.call.muted && ${noDialog}`);
  // The bar is drawn inside a fixed-width window, so its status and controls must
  // stay on one row: a folded status line reads as two rows of chrome. Narrowing
  // the window proves the bar neither folds the row nor under-reports the width it
  // needs — that report is what lets main grow the window to the content.
  await evaluate("window.liveVoiceFixture.setWidgetWindowWidth(240)");
  await frame();
  await check("a status line too wide for the window stays one row and reports its width",
    `(() => {
      const status = document.querySelector('.live-voice-call-status > span');
      const actions = document.querySelector('.live-voice-call-actions');
      const report = window.liveVoiceFixture.inspect().widget.presentation;
      if (!status || !actions || !report) return false;
      return status.getClientRects().length === 1 &&
        Math.abs(status.getBoundingClientRect().top - actions.getBoundingClientRect().top) < 6 &&
        report.width >= Math.ceil(status.scrollWidth) - 2;
    })()`);
  await evaluate("window.liveVoiceFixture.setWidgetWindowWidth(420)");
  await frame();
  // The pending decision lives in the owner window's store, which the widget
  // window does not have: the owner frame reports it, main forwards it, and the
  // bar names it. Seeding the owner store is therefore the whole test.
  await evaluate("window.liveVoiceFixture.pendingAsk('fixture-session-1', 'Ship beta.1?')");
  await check("a decision the bound session waits on reaches the widget bar",
    `document.querySelector('.live-voice-call-bar')?.textContent.includes('waiting for your answer or approval') === true`);
  await evaluate("window.liveVoiceFixture.clearPendingAsks()");
  await check("the waiting hint clears with the decision",
    `document.querySelector('.live-voice-call-bar')?.textContent.includes('waiting for your answer or approval') === false`);
  await capture("call-connected");
  await evaluate("window.liveVoiceFixture.setPhase('reconnecting')");
  await check("reconnecting keeps an explicit End action", `ui.state('reconnecting') && ${button("End call", bar)} && !${button("Cancel", bar)} && !${button("Unmute microphone", bar)}`);
  await evaluate("window.liveVoiceFixture.setPhase('connected')");
  await connected();
  await click(button("Unmute microphone", bar));
  // The press left the widget as an action, and the widget reported the visible
  // box main has to show: the widget window is not the call owner and never
  // reaches the controller itself.
  await check("a widget press travels to the owner frame as an action",
    "s.widget.actions.includes('mute') && s.widget.visible && s.widget.presentation.width > 0 && s.widget.presentation.height > 0");
  await check("unmute opens the real controller capture gate", `${button("Mute microphone", bar)} && !s.snapshot.call.muted && s.tracks[0].enabled && s.counts.mute === 1`);
  await click(button("Mute microphone", bar));
  await check("mute immediately closes the capture gate", `${button("Unmute microphone", bar)} && s.snapshot.call.muted && !s.tracks[0].enabled && s.counts.mute === 2`);
  await evaluate("window.liveVoiceFixture.transcript('Fixture provider transcript')");
  for (const method of ["Close", "Escape", "outside"]) {
    await click(button("Call details", bar));
    await wait("details show actual transcript", `ui.dialog(${JSON.stringify(details)}) && document.querySelector(${JSON.stringify(details)})?.textContent.includes('Fixture provider transcript')`);
    if (method === "Close") await capture("call-details");
    if (method === "Close") await click(button("Close", details));
    else if (method === "Escape") await key("Escape");
    else await click(button("Fixture chat route"));
    await check(`${method} dismisses details without ending the call`, `${noDialog} && ui.state('connected') && s.counts.end === 0`);
  }
  await key("Escape");
  await check("Escape never ends a connected call", "ui.state('connected') && s.counts.end === 0");
  await key("V", [process.platform === "darwin" ? "meta" : "control", "shift"]);
  await check("existing Mod+Shift+V shortcut ends the connected call",
    `s.counts.end === 1 && !s.snapshot.stopping && s.snapshot.call?.phase === 'ended' && ${button("Live voice")}`);
  await clean();
}

async function playbackScenario() {
  await fresh();
  await evaluate("window.liveVoiceFixture.blockPlayback(true)");
  await start();
  await connected();
  await check("blocked output exposes Resume sound with details closed",
    `s.snapshot.call.playbackBlocked && ${button("Resume sound")} && ${noDialog}`);
  await click(button("Resume sound"));
  // Widget IPC cannot carry transient user activation. The owner window is
  // focused and exposes a real owner-frame control for the retry.
  await check("widget playback recovery hands off to the owner frame",
    `ui.dialog(${JSON.stringify(details)}) && ${button("Resume sound", details)} && s.counts.play === 1`);
  await click(button("Resume sound", details));
  await check("failed playback retry is visible after owner-frame activation",
    `s.snapshot.errorCode === 'LIVE_PLAYBACK_FAILED' && document.body.textContent.includes('LIVE_PLAYBACK_FAILED') && ${button("Resume sound", details)} && s.counts.play >= 2`);
  await evaluate("window.liveVoiceFixture.blockPlayback(false)");
  await click(button("Resume sound", details));
  await check("successful owner-frame retry clears playback blockage and error",
    `!s.snapshot.call.playbackBlocked && !s.snapshot.errorCode && !${button("Resume sound", details)}`);
  await click(button("End call", bar));
  await wait("playback call ended", "!s.snapshot.stopping && s.snapshot.call?.phase === 'ended'");
  await clean();
}

async function enableWork() {
  await openPreparation();
}
async function workScenario() {
  await fresh();
  await enableWork();
  await check("Composer target is default; context consent is separate and unchecked",
    `${checkbox("Share limited recent conversation context")}?.checked === false && !${checkbox("Allow work requests")} && ${noMedia}`);
  await click(checkbox("Share limited recent conversation context"));
  await evaluate("window.liveVoiceFixture.switchSession('fixture-session-2')");
  await check("changing Composer session preserves independent context consent",
    `${checkbox("Share limited recent conversation context")}?.checked === true && ${noMedia}`);
  await click(button("Start Live voice", prep));
  await connected();
  await check("Start sends the current Composer target and separate context consent",
    "s.requests.prepare[0].workTarget?.workSessionId === 'fixture-session-2' && s.requests.prepare[0].shareSelectedSessionContext === true && !('contextEnabled' in s.requests.prepare[0].workTarget) && s.counts.audioContext === 1");
  await click(button("End call", bar));
  await wait("work call ended", `!s.snapshot.stopping && ${button("Live voice")}`);
  await openPreparation();
  await check("reopening preparation resets call-only context consent",
    `${checkbox("Share limited recent conversation context")}?.checked === false && !${checkbox("Allow work requests")}`);
  await key("Escape");
  await clean();
}

async function unconfirmedReleaseScenario() {
  await fresh();
  await enableWork();
  await click(button("Start Live voice", prep));
  await connected();
  await evaluate("window.liveVoiceFixture.failReleaseReport(); window.liveVoiceFixture.beginClosing()");
  await check("release failure keeps Ending until Main reports quarantine",
    "s.snapshot.stopping && s.counts.released === 1 && s.contexts[0].state === 'closed' && ui.state('stopping')");
  await evaluate("window.liveVoiceFixture.terminalUnconfirmed()");
  await check("unconfirmed release stays visible and suppresses another Start",
    `!s.snapshot.stopping && s.snapshot.call?.error?.code === 'LIVE_MEDIA_RELEASE_UNCONFIRMED' && s.widget.visible && ui.all('[role="alert"]').some(element => element.textContent.includes('Microphone release could not be confirmed')) && !${button("Live voice")} && !${button("Dismiss", bar)}`);
  await capture("call-release-quarantined");
  const attempt = await evaluate("window.liveVoiceFixture.attemptStart()");
  assert.equal(attempt, "LIVE_MEDIA_RELEASE_UNCONFIRMED");
  await check("Main quarantine cannot be cleared by retrying from the controller",
    "s.counts.prepare === 1 && s.snapshot.call?.error?.code === 'LIVE_MEDIA_RELEASE_UNCONFIRMED'");
  await clean();
}
async function shellAndDisableScenario() {
  await fresh();
  await enableWork();
  await click(button("Start Live voice", prep));
  await connected();
  await click(button("Fixture toggle composer visibility"));
  await check("global status survives the simulated hidden composer boundary",
    "document.querySelector('[data-fixture-composer]')?.hidden && ui.state('connected') && s.widget.visible");
  await click(button("Fixture settings route"));
  await check("global status survives simulated route unmount",
    `!document.querySelector('[data-fixture-composer]') && ui.state('connected') && ${button("End call", bar)} && s.counts.end === 0`);
  await click(button("Unmute microphone", bar));
  await check("global call remains controllable away from composer", "!s.snapshot.call.muted && s.tracks[0].enabled");
  await evaluate("window.liveVoiceFixture.hold('contextClose'); window.liveVoiceFixture.hold('released'); window.liveVoiceFixture.configure({ enabled: false }); window.liveVoiceFixture.beginClosing()");
  await check("disable keeps stopping visible while AudioContext release is delayed",
    "s.snapshot.status.enabled === false && s.snapshot.stopping && ui.state('stopping') && s.counts.contextClose === 1 && s.contexts[0].state !== 'closed'");
  await evaluate("window.liveVoiceFixture.terminal()");
  await check("terminal view before local release cannot hide Ending status",
    "s.snapshot.call?.phase === 'ended' && s.snapshot.stopping && ui.state('stopping') && document.querySelector('.live-voice-call-bar').textContent.includes('Ending')");
  await evaluate("window.liveVoiceFixture.release('contextClose')");
  await check("release report acknowledgement also gates stopping",
    "s.counts.released === 1 && s.contexts[0].state === 'closed' && s.snapshot.stopping && ui.state('stopping')");
  await evaluate("window.liveVoiceFixture.release('released')");
  await check("disabled status disappears only after local cleanup settles",
    "!s.snapshot.stopping && !s.widget.visible && s.tracks.every(track => track.readyState === 'ended')");
  await click(button("Fixture chat route"));
  await check("returning to composer while disabled leaves no Live or work icons",
    "ui.all('button', undefined, '[data-fixture-composer]').length === 0 && s.counts.prepare === 1 && s.counts.getUserMedia === 1");
  await clean();
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: false, width: 1120, height: 840, useContentSize: true,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { permissionRequests += 1; callback(false); });
  win.webContents.session.setPermissionCheckHandler(() => false);
  const origin = new URL(process.env.PI_LIVE_VOICE_FIXTURE_URL).origin;
  win.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    const allowed = new URL(request.url).origin === origin || /^(data|blob):/.test(request.url);
    if (!allowed) deniedRequests.push(request.url);
    callback({ cancel: !allowed });
  });
  for (const scenario of [preparationScenario, cancellationScenario, connectedScenario, playbackScenario, workScenario, shellAndDisableScenario, unconfirmedReleaseScenario]) {
    console.log(`SCENARIO ${scenario.name}`);
    await scenario();
  }
  assert.equal(permissionRequests, 0, "Fixture must never request real microphone permission");
  assert.deepEqual(deniedRequests, [], "Fixture must never attempt external network access");
  writeFileSync(artifact("results.json"), JSON.stringify({
    scope: "Mounted production controls/controller/store/i18n with simulated shell visibility and fake external edges; not full AppShell or provider/device E2E",
    results, permissionRequests, deniedRequests,
  }, null, 2));
  console.log(`SUMMARY ${results.length}/${results.length} passed`);
  win.destroy(); app.exit(0);
}).catch(async (error) => {
  console.error(error.stack);
  results.push({ name: "scenario aborted", ok: false, error: String(error.stack ?? error) });
  writeFileSync(artifact("results.json"), JSON.stringify({ results, permissionRequests, deniedRequests }, null, 2));
  if (win && !win.isDestroyed()) {
    try { writeFileSync(artifact("failure.png"), (await win.webContents.capturePage()).toPNG()); }
    catch (captureError) { console.error("Failure screenshot unavailable", captureError); }
    win.destroy();
  }
  app.exit(1);
});
