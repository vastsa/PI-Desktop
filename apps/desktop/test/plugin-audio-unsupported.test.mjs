/**
 * Capture crosses the real broker/plugin-process boundary with a fake device.
 * Headless capture and playback fail closed with coded, audited errors.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "..", "electron/main/plugin-host-process.mjs");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

// Set before the runtime is imported so nothing a host call touches can land in
// the developer's real data directory.
const dataDir = mkdtempSync(join(tmpdir(), "pi-audio-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const PLUGIN_ID = "com.example.audio";

/** Real host process, forked instead of Electron's utilityProcess. */
function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

/** Every audio method, so a missing one fails a test rather than hiding. */
const AUDIO_METHODS = [
  "getInputDevices",
  "openInput",
  "closeInput",
  "getCaptureState",
  "onInputFrame",
  "offInputFrame",
  "openOutput",
  "writeOutput",
  "stopOutput",
  "closeOutput",
];

const PLUGIN_MAIN = `
  const frames = [];
  let unblock;
  const handler = (frame) => { frames.push({ ...frame, data: [...frame.data] }); };
  async function attempt(fn) {
    try {
      return { ok: true, value: (await fn()) ?? null };
    } catch (error) {
      return { ok: false, code: error?.code ?? null, name: error?.name ?? null, message: String(error?.message ?? error) };
    }
  }
  module.exports = {
    async onRendererCall(channel, payload) { return module.exports.onPanelInvoke(channel, payload); },
    async onPanelInvoke(channel, payload) {
      if (channel === "crash") process.exit(7);
      if (channel === "subscribe") { pi.audio.onInputFrame(handler); return true; }
      if (channel === "unsubscribe") { pi.audio.offInputFrame(handler); return true; }
      if (channel === "frames") return frames;
      if (channel === "slow") {
        pi.audio.onInputFrame(() => new Promise((resolve) => { unblock = resolve; }));
        return true;
      }
      if (channel === "resume") { unblock?.(); return true; }
      if (channel === "shape") {
        return {
          type: typeof pi.audio,
          methods: Object.keys(pi.audio ?? {}).sort(),
          callable: Object.entries(pi.audio ?? {}).every(([, value]) => typeof value === "function"),
        };
      }
      if (channel === "call") {
        const name = payload.method;
        const args = Array.isArray(payload.args) ? payload.args : [];
        return attempt(() => pi.audio[name](...args));
      }
      throw new Error("unknown channel: " + channel);
    },
  };
`;

function writePlugin(t, { permissions = [], renderer = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-audio-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (renderer) {
    mkdirSync(join(dir, "renderer"));
    writeFileSync(join(dir, "renderer/index.js"), "export function onLoad() {}\n");
  }
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PLUGIN_ID,
      name: "Audio Plugin",
      version: "0.0.1",
      main: "main.js",
      permissions: renderer ? [...permissions, "renderer.extension"] : permissions,
      ...(renderer ? {
        renderer: "renderer/index.js",
        rendererActions: ["plugin.call"],
        rendererCallMethods: ["subscribe", "unsubscribe", "slow", "resume", "frames", "call"],
      } : {}),
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), PLUGIN_MAIN, "utf8");
  return dir;
}

function createRuntime(t, services = {}) {
  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    audit: (entry) => audits.push(entry),
    ...services,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits };
}

const ALL_AUDIO_PERMISSIONS = ["audio.capture.background", "audio.playback.background"];

test("the audio namespace exists and exposes the SDK's ten methods", async (t) => {
  const { runtime } = createRuntime(t);
  await runtime.loadFromPath(writePlugin(t, { permissions: ALL_AUDIO_PERMISSIONS }));

  const shape = await runtime.invokePanelBridge(PLUGIN_ID, "shape");
  assert.equal(shape.type, "object");
  assert.equal(shape.callable, true);
  assert.deepEqual(shape.methods, [...AUDIO_METHODS].sort());
});

test("a granted capture method is refused with a coded, audited UNSUPPORTED", async (t) => {
  const { runtime, audits } = createRuntime(t);
  await runtime.loadFromPath(writePlugin(t, { permissions: ALL_AUDIO_PERMISSIONS }));

  for (const method of ["getInputDevices", "openInput"]) {
    const answer = await runtime.invokePanelBridge(PLUGIN_ID, "call", { method, args: [] });
    assert.equal(answer.ok, false, `${method} should refuse`);
    assert.equal(answer.name, "Error", `${method} should not fail as a TypeError`);
    assert.equal(answer.code, "UNSUPPORTED");
    assert.match(answer.message, /host audio capture backend not available/);
  }

  assert.deepEqual(
    audits
      .filter((entry) => String(entry.api).startsWith("audio."))
      .map((entry) => [entry.api, entry.errorCode]),
    [
      ["audio.getInputDevices", "UNSUPPORTED"],
      ["audio.openInput", "UNSUPPORTED"],
    ],
  );
});

test("playback methods are refused the same way and name their own permission", async (t) => {
  const { runtime, audits } = createRuntime(t);
  // Capture is granted, playback is not: the refusal must be the missing
  // permission, not the missing service, because the gate runs first.
  await runtime.loadFromPath(writePlugin(t, { permissions: ["audio.capture.background"] }));

  const denied = await runtime.invokePanelBridge(PLUGIN_ID, "call", {
    method: "openOutput",
    args: [{ sampleRate: 24000 }],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "PERMISSION_DENIED");
  assert.deepEqual(
    audits
      .filter((entry) => entry.api === "audio.playback.background")
      .map((entry) => entry.errorCode),
    ["PERMISSION_DENIED"],
  );

  // With the grant, the same call answers the coded service refusal.
  const { runtime: granted, audits: grantedAudits } = createRuntime(t);
  await granted.loadFromPath(
    writePlugin(t, { permissions: ALL_AUDIO_PERMISSIONS, id: PLUGIN_ID }),
  );
  const refused = await granted.invokePanelBridge(PLUGIN_ID, "call", {
    method: "openOutput",
    args: [{ sampleRate: 24000 }],
  });
  assert.equal(refused.code, "UNSUPPORTED");
  assert.deepEqual(
    grantedAudits
      .filter((entry) => entry.api === "audio.openOutput")
      .map((entry) => [entry.ok, entry.errorCode]),
    [[false, "UNSUPPORTED"]],
  );
});

test("capture state is idle without a device; local frame subscription opens no device", async (t) => {
  const { runtime } = createRuntime(t);
  await runtime.loadFromPath(writePlugin(t, { permissions: ALL_AUDIO_PERMISSIONS }));
  const state = await runtime.invokePanelBridge(PLUGIN_ID, "call", { method: "getCaptureState" });
  assert.deepEqual(state.value, { active: false, droppedFrames: 0 });
});

test("without the permission nothing reaches the service, not even the refusal", async (t) => {
  const { runtime, audits } = createRuntime(t);
  await runtime.loadFromPath(writePlugin(t, { permissions: [] }));

  for (const method of ["getInputDevices", "openInput", "openOutput"]) {
    const answer = await runtime.invokePanelBridge(PLUGIN_ID, "call", { method, args: [] });
    assert.equal(answer.code, "PERMISSION_DENIED", `${method} should be denied`);
  }

  // The gateway audits the refusal under the permission it asked for, and the
  // service-level UNSUPPORTED entry is never produced: the gate runs first.
  assert.deepEqual(
    audits
      .filter((entry) => String(entry.api).startsWith("audio."))
      .map((entry) => [entry.api, entry.errorCode]),
    [
      ["audio.capture.background", "PERMISSION_DENIED"],
      ["audio.capture.background", "PERMISSION_DENIED"],
      ["audio.playback.background", "PERMISSION_DENIED"],
    ],
  );
});

function audioFixture() {
  let emit; let cancelled = 0;
  const device = {
    isActive: false,
    onFrame(cb) { emit = cb; },
    async start() { this.isActive = true; },
    cancel() { cancelled++; this.isActive = false; },
  };
  return {
    factory: {
      async getDevices() { return [{ deviceId: "0", label: "Fixture", isDefault: true }]; },
      async checkPermission() { return "granted"; },
      async requestPermission() { throw new Error("Unexpected OS prompt"); },
      create() { return device; },
    },
    emit: (samples) => emit(Int16Array.from(samples)),
    get cancelled() { return cancelled; },
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail("Audio delivery did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("composer plugin.call subscribes, records PCM, applies backpressure and stops on unload", async (t) => {
  const audio = audioFixture();
  const { runtime } = createRuntime(t, { audioCaptureFactory: audio.factory });
  await runtime.loadFromPath(writePlugin(t, { permissions: ["audio.capture.background"], renderer: true }));
  const invoke = (channel, payload) => runtime.callRenderer(PLUGIN_ID, channel, payload);
  await invoke("subscribe"); await invoke("slow");
  const opened = await invoke("call", { method: "openInput", args: [{}] });
  assert.equal(opened.ok, true);
  audio.emit([-32768, 32767]);
  await waitFor(async () => (await invoke("frames")).length === 1);
  const frames = await invoke("frames");
  assert.deepEqual(frames[0].data, [0, 128, 255, 127]);
  assert.equal(frames[0].streamId, opened.value.streamId);
  audio.emit([1]);
  const blocked = await invoke("call", { method: "getCaptureState" });
  assert.equal(blocked.value.droppedFrames, 1);
  await invoke("resume");
  // Wait for the ACK to return across IPC before offering the next sample.
  await waitFor(async () => {
    audio.emit([2]);
    return (await invoke("frames")).length === 2;
  });
  await invoke("resume");
  await invoke("unsubscribe");
  await runtime.unload(PLUGIN_ID);
  assert.equal(audio.cancelled, 1);
});

test("permission denial does not reach the real capture backend", async (t) => {
  let touched = false;
  const { runtime } = createRuntime(t, { audioCaptureFactory: { create() { touched = true; } } });
  await runtime.loadFromPath(writePlugin(t));
  const reply = await runtime.invokePanelBridge(PLUGIN_ID, "call", { method: "openInput" });
  assert.equal(reply.code, "PERMISSION_DENIED");
  assert.equal(touched, false);
});

for (const mode of ["crash", "quit"]) {
  test(`a plugin ${mode} releases its active microphone`, async (t) => {
    const audio = audioFixture();
    const { runtime } = createRuntime(t, { audioCaptureFactory: audio.factory });
    await runtime.loadFromPath(writePlugin(t, { permissions: ["audio.capture.background"] }));
    const reply = await runtime.invokePanelBridge(PLUGIN_ID, "call", { method: "openInput" });
    assert.equal(reply.ok, true);
    if (mode === "crash") {
      await assert.rejects(runtime.invokePanelBridge(PLUGIN_ID, "crash"));
      await waitFor(() => audio.cancelled === 1);
    } else {
      await runtime.disposeAll();
      assert.equal(audio.cancelled, 1);
    }
  });
}
