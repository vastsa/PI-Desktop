import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginAudioCapture } = await import("../electron/main/plugin-audio-capture.ts");

function fixture({ permission = "granted", granted = true, start } = {}) {
  let callback;
  let cancels = 0;
  let creates = 0;
  let prompts = 0;
  const device = {
    isActive: false,
    onFrame(cb) { callback = cb; },
    async start() { await start?.(); this.isActive = true; },
    cancel() { cancels++; this.isActive = false; },
  };
  const factory = {
    async getDevices() { return [{ deviceId: "0", label: "Fixture microphone", isDefault: true }]; },
    async checkPermission() { return permission; },
    async requestPermission() { prompts++; return granted; },
    create() { creates++; return device; },
  };
  const service = new PluginAudioCapture(() => factory);
  return { service, frame: (samples) => callback(Int16Array.from(samples)), get cancels() { return cancels; }, get creates() { return creates; }, get prompts() { return prompts; } };
}

test("PCM16 bytes, one outstanding frame, ACK ownership, sequence gaps and close", async () => {
  const f = fixture(); const owner = {}; const other = {}; const frames = [];
  const session = await f.service.open(owner, {}, () => true, (frame) => frames.push(frame));
  try {
    f.frame([-32768, 32767, 1]);
    assert.deepEqual([...frames[0].data], [0, 128, 255, 127, 1, 0]);
    f.service.acknowledge(other, session.streamId, 0);
    f.frame([2]);
    assert.equal(frames.length, 1);
    assert.equal(f.service.state(owner).droppedFrames, 1);
    assert.deepEqual(f.service.state(other), { active: false, droppedFrames: 0 });
    assert.throws(() => f.service.close(other, session.streamId), { code: "PERMISSION_DENIED" });
    f.service.acknowledge(owner, session.streamId, 0);
    f.frame([3]);
    assert.equal(frames[1].sequence, 2);
    await assert.rejects(f.service.open(other, {}, () => true, () => {}), { code: "RESOURCE_BUSY" });
    f.service.close(owner, session.streamId);
    f.frame([4]);
    assert.equal(frames.length, 2);
    assert.equal(f.cancels, 1);
  } finally { f.service.release(owner); }
});

test("OS denial and unsupported formats never create a device", async () => {
  const f = fixture({ permission: "undetermined", granted: false });
  await assert.rejects(f.service.open({}, {}, () => true, () => {}), { code: "PERMISSION_DENIED" });
  assert.equal(f.prompts, 1); assert.equal(f.creates, 0);
  for (const options of [{ sampleRate: 48000 }, { channels: 2 }, { noiseSuppression: true }, { sampleRate: NaN }]) {
    await assert.rejects(f.service.open({}, options, () => true, () => {}), { code: "UNSUPPORTED" });
  }
  await assert.rejects(f.service.open({}, { deviceId: "1junk" }, () => true, () => {}), { code: "INVALID_ARGUMENT" });
  assert.equal(f.creates, 0);
});

test("unload during async device startup cannot revive a capture", async () => {
  let resolve; const gate = new Promise((r) => { resolve = r; });
  const f = fixture({ start: () => gate }); const owner = {};
  const opening = f.service.open(owner, {}, () => true, () => {});
  await new Promise(setImmediate);
  f.service.release(owner); resolve();
  await assert.rejects(opening, { code: "PLUGIN_UNLOADED" });
  assert.equal(f.service.state(owner).active, false);
  assert.equal(f.cancels, 2); // once at unload, once after late startup
});

test("host deadline releases an abandoned device", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); const owner = {};
  await f.service.open(owner, {}, () => true, () => {});
  t.mock.timers.tick(60000);
  assert.equal(f.cancels, 1);
  assert.equal(f.service.state(owner).active, false);
});
