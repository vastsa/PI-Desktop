import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  KEYBOARD_SHORTCUTS,
  keybindingMatchesEvent,
  resolveKeybinding,
} from "@pi-desktop/shared";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    location: { origin: "http://localhost" },
    addEventListener() {},
    removeEventListener() {},
    piDesktop: {
      channels: {},
      on: () => () => undefined,
      onLiveVoicePort: () => () => undefined,
      invoke: async () => ({ ok: true, data: {} }),
    },
  },
});

const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false,
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  optimizeDeps: { noDiscovery: true, include: [] },
});
const { runLiveVoiceShortcut } = await server.ssrLoadModule(
  "/src/features/voice/live/live-voice-shortcuts.ts",
);

test.after(async () => {
  await server.close();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete globalThis.window;
});

function shortcutController(snapshot) {
  const actions = [];
  return {
    actions,
    controller: {
      getSnapshot: () => snapshot,
      start: async () => { actions.push("start"); },
      end: async () => { actions.push("end"); },
      cancelStart: async () => { actions.push("cancel"); },
    },
  };
}

const voiceStatus = {
  enabled: true,
  bindings: [{ selectable: true }],
};

test("configured voiceToggle binding starts and ends Live Voice", () => {
  const definition = KEYBOARD_SHORTCUTS.find(({ id }) => id === "voiceToggle");
  assert.ok(definition);
  const binding = resolveKeybinding(definition, undefined, "darwin");
  assert.equal(binding, "Mod+Shift+V");
  assert.equal(
    keybindingMatchesEvent(binding, { key: "v", metaKey: true, shiftKey: true }, "darwin"),
    true,
  );

  const starting = shortcutController({ status: voiceStatus, call: null, starting: false });
  assert.equal(runLiveVoiceShortcut("voiceToggle", starting.controller), true);
  assert.deepEqual(starting.actions, ["start"]);

  const connected = shortcutController({
    status: voiceStatus,
    call: { phase: "connected" },
    starting: false,
  });
  assert.equal(runLiveVoiceShortcut("voiceToggle", connected.controller), true);
  assert.deepEqual(connected.actions, ["end"]);
});

test("voiceToggle does not duplicate startup or start without a selectable binding", () => {
  const pending = shortcutController({ status: voiceStatus, call: null, starting: true });
  assert.equal(runLiveVoiceShortcut("voiceToggle", pending.controller), false);
  assert.deepEqual(pending.actions, []);

  for (const status of [
    { enabled: false, bindings: [{ selectable: true }] },
    { enabled: true, bindings: [{ selectable: false }] },
    null,
  ]) {
    const unavailable = shortcutController({ status, call: null, starting: false });
    assert.equal(runLiveVoiceShortcut("voiceToggle", unavailable.controller), false);
    assert.deepEqual(unavailable.actions, []);
  }
});

test("voiceCancel cancels startup only and never ends an active call", () => {
  const cancelDefinition = KEYBOARD_SHORTCUTS.find(({ id }) => id === "voiceCancel");
  assert.ok(cancelDefinition);
  const cancelBinding = resolveKeybinding(cancelDefinition, undefined, "darwin");
  assert.equal(cancelBinding, "Escape");
  assert.equal(keybindingMatchesEvent(cancelBinding, { key: "Escape" }, "darwin"), true);
  const pending = shortcutController({ status: voiceStatus, call: null, starting: true });
  assert.equal(runLiveVoiceShortcut("voiceCancel", pending.controller), true);
  assert.deepEqual(pending.actions, ["cancel"]);

  const connected = shortcutController({
    status: voiceStatus,
    call: { phase: "connected" },
    starting: false,
  });
  assert.equal(runLiveVoiceShortcut("voiceCancel", connected.controller), false);
  assert.deepEqual(connected.actions, []);
});
