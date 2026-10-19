import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const renderer = await import("../src/lib/api.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const main = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });

test("settings read-modify-write preserves disabled retry and unrelated preferences", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    for (const stored of [{}, { infiniteProviderRetry: false }, { infiniteProviderRetry: true }]) {
      const original = { defaultMode: "agent", theme: "light", ...stored };
      const received = structuredClone(main.normalizeSettings(original));
      const displayed = renderer.normalizeSettings(received);
      const edited = { ...displayed, imageGeneration: { providerId: "images", modelId: "image" } };
      const outgoing = renderer.validateSettingsWrite(edited);
      const persisted = main.validateSettingsWrite(structuredClone(outgoing));
      assert.equal(persisted.infiniteProviderRetry, stored.infiniteProviderRetry === true);
      assert.equal(persisted.theme, "light");
      assert.deepEqual(persisted.imageGeneration, edited.imageGeneration);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("invalid retry writes stay rejected at both boundaries", () => {
  for (const value of [undefined, null, "yes", 0, {}]) {
    const settings = { infiniteProviderRetry: value };
    assert.throws(() => renderer.validateSettingsWrite(settings), /infiniteProviderRetry is invalid/);
    assert.throws(() => main.validateSettingsWrite(settings), /infiniteProviderRetry is invalid/);
  }
});

test("Jev classifier settings normalize safely and reject corrupt writes", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    const binding = {
      baseUrl: "https://openrouter.test/api/v1/systemone/",
      modelId: " ~typesafe/jev-latest ",
    };
    const normalized = renderer.normalizeSettings({
      defaultMode: "agent",
      jevEnabled: true,
      jevClassifier: binding,
    });
    assert.equal(normalized.jevEnabled, true);
    assert.deepEqual(normalized.jevClassifier, {
      baseUrl: "https://openrouter.test/api/v1",
      modelId: "~typesafe/jev-latest",
    });
    assert.deepEqual(main.validateSettingsWrite(structuredClone(normalized)).jevClassifier,
      normalized.jevClassifier);

    for (const invalid of [null, {}, { baseUrl: "file:///tmp", modelId: "jev" },
      { baseUrl: "https://openrouter.test/api/v1", modelId: "two ids" }]) {
      const stored = renderer.normalizeSettings({
        defaultMode: "agent",
        jevEnabled: true,
        jevClassifier: invalid,
      });
      assert.equal(stored.jevEnabled, false, "corrupt explicit binding must fail closed");
      assert.equal(stored.jevClassifier, null);
    }
    assert.throws(
      () => renderer.validateSettingsWrite({ jevClassifier: { baseUrl: "bad", modelId: "" } }),
      /jevClassifier is invalid/,
    );
    assert.throws(
      () => main.validateSettingsWrite({ jevClassifier: { baseUrl: "bad", modelId: "" } }),
      /jevClassifier is invalid/,
    );
    assert.equal(renderer.validateSettingsWrite({ jevClassifier: null }).jevClassifier, null);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
