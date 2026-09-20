import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("speech IPC is on the typed whitelist and renderer API", async () => {
  const [protocol, api, registerSrc] = await Promise.all([
    read("../../../packages/shared/src/protocol.ts"),
    read("../src/lib/api.ts"),
    read("../electron/main/ipc/register.ts"),
  ]);
  assert.match(protocol, /speechTranscribe: "pi-desktop\/speech\/transcribe"/);
  assert.match(protocol, /speechSynthesize: "pi-desktop\/speech\/synthesize"/);
  assert.match(protocol, /speechGetStatus: "pi-desktop\/speech\/getStatus"/);
  assert.match(api, /IPC\.invoke\.speechGetStatus/);
  assert.match(api, /IPC\.invoke\.speechTranscribe/);
  assert.match(api, /validateSpeechSettings/);
  assert.match(registerSrc, /registerSpeechIpc/);
});


test("settings reject an illegal speech protocol id", async () => {
  const { validateSpeechSettings } = await import("@pi-desktop/shared");
  assert.throws(
    () =>
      validateSpeechSettings({
        transcribe: { providerId: "p", modelId: "m", protocol: "OpenAI Audio" },
      }),
    /protocol is invalid/,
  );
});

function speechHarness({ transcribeProtocol = "openai_audio", synthesizeProtocol } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-speech-svc-"));
  test.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const scratch = join(dataDir, "scratch", "sess");
  const host = {
    call: async (method) => {
      if (method === "settings.get") {
        return {
          speech: {
            transcribe: { providerId: "p", modelId: "whisper-1", protocol: transcribeProtocol },
            ...(synthesizeProtocol
              ? { synthesize: { providerId: "p", modelId: "tts-1", protocol: synthesizeProtocol } }
              : {}),
          },
        };
      }
      if (method === "providers.get") {
        return { provider: { id: "p", baseUrl: "https://api.openai.com/v1", enabled: true } };
      }
      if (method === "providers.getSecret") return { value: "sk" };
      if (method === "session.getScratchPath") return { path: scratch };
      throw new Error(method);
    },
  };
  return { dataDir, scratch, host };
}

test("speech-service keeps transcription inside session scratch", async () => {
  const { createSpeechService } = await import("../electron/main/services/speech-service.ts");
  const { dataDir, host } = speechHarness();
  const outside = join(dataDir, "outside.wav");
  writeFileSync(outside, "RIFF");
  const speech = createSpeechService({
    dataDir,
    getHost: () => host,
    plugins: { listSpeechAdapters: () => [], getSpeechAdapter: () => undefined, runSpeechAdapter: async () => ({}) },
    logger: { app() {} },
  });
  await assert.rejects(
    () => speech.transcribe({ sessionId: "sess", path: outside }),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    () => speech.transcribe({ path: outside }),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
});

test("speech-service rejects a protocol that cannot transcribe", async () => {
  const { createSpeechService } = await import("../electron/main/services/speech-service.ts");
  const { dataDir, scratch, host } = speechHarness({ transcribeProtocol: "openai_chat_audio" });
  const speech = createSpeechService({
    dataDir,
    getHost: () => host,
    plugins: { listSpeechAdapters: () => [], getSpeechAdapter: () => undefined, runSpeechAdapter: async () => ({}) },
    logger: { app() {} },
  });
  await assert.rejects(
    () => speech.transcribe({ sessionId: "sess", path: join(scratch, "a.wav") }),
    (error) => error.errorCode === "SPEECH_PROTOCOL_UNSUPPORTED",
  );
});
