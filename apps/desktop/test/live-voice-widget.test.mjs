import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// The docked Live Voice widget is a desktop-level window: frameless, always on
// top, transparent, dragged through its own app-region handle. What can be
// proven without a display is the arithmetic that keeps a saved placement and
// the widget's self-reported box on screen, plus the validation of the two
// channels the widget may use. The window itself is covered by the Live Voice
// e2e run against the real app.

async function desktopModules(t) {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  return {
    placement: await server.ssrLoadModule("/electron/main/live-voice/widget-geometry.ts"),
    ipc: await server.ssrLoadModule("/electron/main/ipc/live-voice-ipc.ts"),
  };
}

test("a dragged Live Voice widget stays inside the work area", async (t) => {
  const { placement } = await desktopModules(t);
  const primary = { x: 0, y: 0, width: 1440, height: 900 };
  const bar = { width: 420, height: 64 };
  const clamp = placement.clampLiveVoiceWidgetPosition;

  assert.deepEqual(clamp({ x: 400, y: 300 }, bar, primary), { x: 400, y: 300 },
    "a placement the user picked inside the work area is kept");
  assert.deepEqual(clamp({ x: -120, y: -40 }, bar, primary), { x: 8, y: 8 },
    "dragging past the top-left edge pins the widget to the margin");
  assert.deepEqual(clamp({ x: 9000, y: 9000 }, bar, primary), { x: 1012, y: 828 },
    "dragging past the bottom-right edge keeps the whole widget inside");
  // A second display has its own origin: the clamp follows the work area it was
  // measured against, not the primary 0,0.
  const secondary = { x: 1600, y: -200, width: 1280, height: 800 };
  assert.deepEqual(clamp({ x: 0, y: -900 }, bar, secondary), { x: 1608, y: -192 },
    "the margin is relative to the work area the widget is on");
  assert.deepEqual(clamp({ x: 40, y: 40 }, { width: 2000, height: 1000 }, primary), { x: 8, y: 8 },
    "a widget larger than the work area cannot compute a negative maximum");

  assert.equal(placement.parseLiveVoiceWidgetPosition(null), null, "no saved placement is the default corner");
  assert.equal(placement.parseLiveVoiceWidgetPosition("not json"), null, "unreadable text is the default corner");
  assert.equal(placement.parseLiveVoiceWidgetPosition("[10,20]"), null, "a value that is not a placement is ignored");
  assert.equal(placement.parseLiveVoiceWidgetPosition('{"x":10}'), null, "a half-written placement is ignored");
  assert.equal(placement.parseLiveVoiceWidgetPosition('{"x":"10","y":20}'), null, "a non-numeric coordinate is ignored");
  assert.deepEqual(placement.parseLiveVoiceWidgetPosition('{"x":10.6,"y":-3.2}'), { x: 11, y: -3 },
    "a saved placement is a whole pixel");
});

test("the widget reports the box its own content needs, bounded to the bar", async (t) => {
  const { placement } = await desktopModules(t);
  const size = placement.clampLiveVoiceWidgetSize;

  assert.deepEqual(size({ width: 380, height: 60 }), { width: 380, height: 60 }, "a measured box is used as-is");
  assert.deepEqual(size({ width: 10, height: 4 }), { width: 220, height: 40 },
    "a box too small to hold the controls grows to the minimum");
  assert.deepEqual(size({ width: 5000, height: 5000 }), { width: 680, height: 260 },
    "a box the bar cannot need is capped");
  assert.deepEqual(size({ width: Number.NaN, height: Number.NaN }), { width: 420, height: 64 },
    "an unmeasurable box falls back to the default");
});

test("only the widget's own actions and box are accepted on its channels", async (t) => {
  const { ipc } = await desktopModules(t);

  for (const action of ["cancel", "mute", "resume", "end", "details", "settings"]) {
    assert.equal(ipc.parseWidgetAction({ action }), action, action);
  }
  assert.throws(() => ipc.parseWidgetAction({ action: "prepare" }), { errorCode: "LIVE_PROTOCOL_ERROR" },
    "the widget cannot drive call setup by naming an owner action");
  assert.throws(() => ipc.parseWidgetAction({}), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(() => ipc.parseWidgetAction({ action: 42 }), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(() => ipc.parseWidgetAction({ action: "end", callId: "call-a" }), { errorCode: "LIVE_PROTOCOL_ERROR" },
    "an action carries nothing else: the owner frame resolves the call");

  assert.deepEqual(
    ipc.parseWidgetPresentation({ visible: true, width: 380, height: 60 }),
    { visible: true, width: 380, height: 60 },
  );
  assert.deepEqual(
    ipc.parseWidgetPresentation({ visible: false, width: 220, height: 40 }),
    { visible: false, width: 220, height: 40 },
    "hiding is a presentation report too, so the placement can be saved",
  );
  assert.throws(() => ipc.parseWidgetPresentation({ visible: true, width: 380 }), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(() => ipc.parseWidgetPresentation({ visible: "yes", width: 380, height: 60 }), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(() => ipc.parseWidgetPresentation({ visible: true, width: Number.NaN, height: 60 }), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(
    () => ipc.parseWidgetPresentation({ visible: true, width: 380, height: 60, x: 10 }),
    { errorCode: "LIVE_PROTOCOL_ERROR" },
    "the widget cannot move itself: the window layer owns the position",
  );
});

test("widget IPC handlers enforce renderer ownership", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { registerLiveVoiceIpc } = await server.ssrLoadModule("/electron/main/ipc/live-voice-ipc.ts");
  const handlers = new Map();
  const mainId = 11;
  const widgetId = 22;
  const registrar = {
    ipcMain: {},
    handle() {},
    handleWithEvent(channel, handler) { handlers.set(channel, handler); },
    assertMainWindowSender(event) {
      if (event.sender.id !== mainId) throw Object.assign(new Error("wrong sender"), { errorCode: "PERMISSION_DENIED" });
    },
  };
  const actions = [];
  const ownerStates = [];
  const widget = {
    owns: (id) => id === widgetId,
    requestAction: (action) => actions.push(action),
    setOwnerState: (state) => ownerStates.push(state),
  };
  const service = new Proxy({}, { get: () => async () => ({}) });
  registerLiveVoiceIpc({ registrar, service, getMainWindow: () => ({ webContents: { id: mainId } }), widget });
  const invoke = (channel, senderId, value) => handlers.get(channel)({ sender: { id: senderId } }, value);
  await invoke("pi-desktop/voice/live/widget/action", widgetId, { action: "mute" });
  assert.deepEqual(actions, ["mute"]);
  await assert.rejects(() => invoke("pi-desktop/voice/live/widget/action", mainId, { action: "mute" }), { errorCode: "PERMISSION_DENIED" });
  await assert.rejects(() => invoke("pi-desktop/voice/live/widget/visibility", mainId, { visible: true, width: 380, height: 60 }), { errorCode: "PERMISSION_DENIED" });
  await assert.rejects(() => invoke("pi-desktop/voice/live/widget/action", 33, { action: "end" }), { errorCode: "PERMISSION_DENIED" });
  // The owner frame reports its own view; the widget window may not forge it.
  await invoke("pi-desktop/voice/live/widget/ownerState", mainId, { callId: "call-a", errorCode: null, decisionWaiting: true });
  assert.deepEqual(ownerStates, [{ callId: "call-a", errorCode: null, decisionWaiting: true }]);
  await assert.rejects(
    () => invoke("pi-desktop/voice/live/widget/ownerState", widgetId, { callId: "call-a", errorCode: null, decisionWaiting: true }),
    { errorCode: "PERMISSION_DENIED" },
  );
});

test("the owner frame's own view of the call is validated before the widget sees it", async (t) => {
  const { ipc } = await desktopModules(t);

  assert.deepEqual(
    ipc.parseWidgetOwnerState({ callId: "call-a", errorCode: "LIVE_PLAYBACK_FAILED", decisionWaiting: true }),
    { callId: "call-a", errorCode: "LIVE_PLAYBACK_FAILED", decisionWaiting: true },
    "the owner's failure code and a waiting decision travel together",
  );
  assert.deepEqual(
    ipc.parseWidgetOwnerState({ callId: "call-a", errorCode: null, decisionWaiting: false }),
    { callId: "call-a", errorCode: null, decisionWaiting: false },
    "clearing both is a normal report, not a silent no-op",
  );
  assert.throws(() => ipc.parseWidgetOwnerState({ callId: "call-a", errorCode: null }), { errorCode: "LIVE_PROTOCOL_ERROR" },
    "a report missing the decision flag is rejected instead of guessed");
  assert.throws(() => ipc.parseWidgetOwnerState({ callId: "call-a", errorCode: null, decisionWaiting: "yes" }), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(() => ipc.parseWidgetOwnerState({ callId: "call-a", errorCode: "", decisionWaiting: false }), { errorCode: "LIVE_PROTOCOL_ERROR" });
  assert.throws(
    () => ipc.parseWidgetOwnerState({ callId: "call-a", errorCode: null, decisionWaiting: false, text: "raw" }),
    { errorCode: "LIVE_PROTOCOL_ERROR" },
    "no free-form text can ride along into the widget",
  );
});
