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

test("custom retry pacing round-trips through both settings boundaries", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    for (const stored of [
      {},
      { providerRetryMaxAttempts: 0, providerRetryInitialDelayMs: 0 },
      { providerRetryMaxAttempts: 3, providerRetryInitialDelayMs: 15_000 },
      { providerRetryMaxAttempts: 10_000, providerRetryInitialDelayMs: 600_000 },
    ]) {
      const original = { defaultMode: "agent", theme: "light", ...stored };
      const received = structuredClone(main.normalizeSettings(original));
      const displayed = renderer.normalizeSettings(received);
      const outgoing = renderer.validateSettingsWrite(displayed);
      const persisted = main.validateSettingsWrite(structuredClone(outgoing));
      assert.equal(
        persisted.providerRetryMaxAttempts,
        stored.providerRetryMaxAttempts,
        "max attempts survive the round trip",
      );
      assert.equal(
        persisted.providerRetryInitialDelayMs,
        stored.providerRetryInitialDelayMs,
        "initial delay survives the round trip",
      );
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("invalid custom retry values are rejected at both boundaries", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    for (const value of [null, "yes", -1, 2.5, {}, Number.NaN]) {
      const settings = { providerRetryMaxAttempts: value, providerRetryInitialDelayMs: value };
      assert.throws(
        () => renderer.validateSettingsWrite(settings),
        /providerRetryMaxAttempts is invalid/,
      );
      assert.throws(
        () => main.validateSettingsWrite(structuredClone(settings)),
        /providerRetryMaxAttempts is invalid/,
      );
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("renderer normalization drops stored junk retry values back to defaults", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    const displayed = renderer.normalizeSettings({
      providerRetryMaxAttempts: -5,
      providerRetryInitialDelayMs: Number.NaN,
    });
    assert.equal(displayed.providerRetryMaxAttempts, undefined);
    assert.equal(displayed.providerRetryInitialDelayMs, undefined);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
