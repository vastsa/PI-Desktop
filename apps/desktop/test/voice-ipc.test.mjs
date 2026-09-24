import assert from "node:assert/strict";
import test from "node:test";

const { parseVoiceModelId, parseVoiceSettings } = await import(
  "../electron/main/ipc/voice-ipc.ts"
);

test("voice IPC accepts only the supported settings shape", () => {
  assert.deepEqual(
    parseVoiceSettings({
      enabled: true,
      deviceId: null,
      languages: ["zh", "en"],
      chineseVariant: "simplified",
      modelId: "whisper-small",
      ignored: "not forwarded",
    }),
    {
      enabled: true,
      deviceId: null,
      languages: ["zh", "en"],
      chineseVariant: "simplified",
      modelId: "whisper-small",
    },
  );
  assert.equal(parseVoiceSettings(undefined, true), undefined);
  assert.throws(() => parseVoiceSettings(undefined), /Invalid voice settings/);
  assert.throws(() => parseVoiceSettings({ languages: [] }), /Invalid voice languages/);
  assert.throws(
    () => parseVoiceSettings({ chineseVariant: "latin" }),
    /Invalid Chinese voice variant/,
  );
});

test("voice model IPC requires a non-empty model id", () => {
  assert.equal(parseVoiceModelId({ modelId: "whisper-small" }), "whisper-small");
  assert.throws(() => parseVoiceModelId({ modelId: "" }), /Invalid voice model id/);
  assert.throws(() => parseVoiceModelId(null), /Invalid voice model id/);
});
