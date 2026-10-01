import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("Voice settings render Live Voice only and preserve legacy settings", async (t) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://localhost" },
      addEventListener() {},
      removeEventListener() {},
      piDesktop: {
        on: () => () => undefined,
        invoke: async () => ({ ok: true, data: { voice: { enabled: true } } }),
      },
    },
  });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  });

  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());

  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { VoiceSettingsSection } = await server.ssrLoadModule(
    "/src/features/settings/voice/VoiceSettingsSection.tsx",
  );
  let savedPatch;
  const html = renderToStaticMarkup(
    React.createElement(VoiceSettingsSection, {
      t: (key) => key,
      settings: {
        voice: {
          enabled: true,
          deviceId: "legacy-microphone",
          languages: ["zh"],
          chineseVariant: "simplified",
          modelId: "legacy-transcription-model",
        },
        liveVoice: { enabled: false, bindings: [] },
      },
      saveSettings: async (patch) => {
        savedPatch = patch;
      },
    }),
  );

  assert.match(html, /liveVoice\.title/);
  assert.match(html, /liveVoice\.enable/);
  for (const legacyLabel of [
    "settings.voiceEnable",
    "settings.voiceMicrophone",
    "settings.voiceLanguages",
    "settings.voiceChineseVariant",
    "settings.voiceModel",
    "legacy-microphone",
    "legacy-transcription-model",
  ]) {
    assert.equal(html.includes(legacyLabel), false, `legacy UI leaked: ${legacyLabel}`);
  }
  assert.equal(savedPatch, undefined);
});

test("Composer keeps Live Voice and no longer mounts local Dictation controls", async () => {
  const composer = await readFile(
    new URL("../src/components/Composer.tsx", import.meta.url),
    "utf8",
  );
  const toolbar = await readFile(
    new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
    "utf8",
  );

  assert.match(composer, /useVoiceInput/);
  assert.doesNotMatch(composer, /VoiceOverlay|voiceEnabled/);
  assert.match(toolbar, /<LiveVoiceControls\b/);
  assert.doesNotMatch(toolbar, /VoiceMicButton|voicePhase|onVoiceToggle|onVoiceCancel/);
});
