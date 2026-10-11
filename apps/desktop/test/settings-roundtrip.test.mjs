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

test("Session references preferences persist through both boundaries; other values are refused", () => {
  const stored = { theme: "light", sessionReferenceBudgetPercent: 50, sessionReferenceMaxTurns: 3 };
  const persisted = main.validateSettingsWrite(structuredClone(renderer.validateSettingsWrite({ ...stored })));
  assert.equal(persisted.sessionReferenceBudgetPercent, 50);
  assert.equal(persisted.sessionReferenceMaxTurns, 3);
  assert.equal(main.normalizeSettings(persisted).sessionReferenceMaxTurns, 3);
  // Absent stays absent: readers fall back to 25 % and 10 turns.
  const plain = renderer.validateSettingsWrite({ theme: "light" });
  assert.equal("sessionReferenceBudgetPercent" in plain, false);
  for (const value of [0, 30, "25", null, 25.5]) {
    assert.throws(() => renderer.validateSettingsWrite({ sessionReferenceBudgetPercent: value }),
      /sessionReferenceBudgetPercent is invalid/);
  }
  for (const value of [0, 4, "10", null, 21]) {
    assert.throws(() => renderer.validateSettingsWrite({ sessionReferenceMaxTurns: value }),
      /sessionReferenceMaxTurns is invalid/);
  }
});
