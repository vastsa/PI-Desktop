import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const renderer = await import("../src/lib/api.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const main = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });

test("current-turn delivery stays opt-in across settings edits and reloads", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    for (const stored of [{}, { sessionMessagesInCurrentTurn: false }, { sessionMessagesInCurrentTurn: true }]) {
      const received = main.normalizeSettings({ defaultMode: "agent", theme: "light", ...stored });
      const displayed = renderer.normalizeSettings(structuredClone(received));
      assert.equal(displayed.sessionMessagesInCurrentTurn, stored.sessionMessagesInCurrentTurn === true);
      // Use the same boolean patch produced by the controlled settings switch.
      const enabled = !displayed.sessionMessagesInCurrentTurn;
      const outgoing = renderer.validateSettingsWrite({ ...displayed, sessionMessagesInCurrentTurn: enabled });
      const persisted = main.validateSettingsWrite(structuredClone(outgoing));
      const reloaded = renderer.normalizeSettings(main.normalizeSettings(persisted));
      assert.equal(reloaded.sessionMessagesInCurrentTurn, enabled);
      assert.equal(reloaded.theme, "light");
      assert.equal(reloaded.defaultMode, "agent");
      const unrelatedEdit = renderer.validateSettingsWrite({ ...reloaded, theme: "dark" });
      assert.equal(main.validateSettingsWrite(unrelatedEdit).sessionMessagesInCurrentTurn, enabled);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("both settings boundaries reject non-boolean current-turn opt-ins", () => {
  for (const value of [undefined, null, "true", "false", 0, 1, {}, []]) {
    const input = { sessionMessagesInCurrentTurn: value };
    assert.throws(() => renderer.validateSettingsWrite(input), /sessionMessagesInCurrentTurn is invalid/);
    assert.throws(() => main.validateSettingsWrite(input), /sessionMessagesInCurrentTurn is invalid/);
  }
});
