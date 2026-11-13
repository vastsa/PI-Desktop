import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { IPC } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const renderer = await import("../src/lib/api.ts");
const { createProviderCatalogRuntime } = await import("../electron/main/runtime/provider-catalog.ts");
const main = createProviderCatalogRuntime({ getHost: () => null, modelsDevCatalog: {} });

test("settings read-modify-write preserves disabled retry and unrelated preferences", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    for (const stored of [
      {},
      { infiniteProviderRetry: false },
      { infiniteProviderRetry: true },
      { keepCommandsExpanded: false },
    ]) {
      const original = { defaultMode: "agent", theme: "light", ...stored };
      const received = structuredClone(main.normalizeSettings(original));
      const displayed = renderer.normalizeSettings(received);
      const edited = { ...displayed, imageGeneration: { providerId: "images", modelId: "image" } };
      const outgoing = renderer.validateSettingsWrite(edited);
      const persisted = main.validateSettingsWrite(structuredClone(outgoing));
      assert.equal(persisted.infiniteProviderRetry, stored.infiniteProviderRetry === true);
      // Absent means on; an explicit false survives both boundaries.
      assert.equal(
        persisted.keepCommandsExpanded,
        stored.keepCommandsExpanded !== false,
      );
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

test("command folding defaults on and rejects non-boolean writes before IPC", () => {
  const previousWindow = globalThis.window;
  let invoked = 0;
  globalThis.window = {
    piDesktop: {
      platform: "win32",
      invoke: async () => {
        invoked += 1;
        return { ok: true, data: undefined };
      },
    },
  };
  try {
    const base = { defaultMode: "agent", theme: "light", enterToSend: true };
    assert.equal(
      renderer.normalizeSettings(base).keepCommandsExpanded,
      true,
    );
    assert.equal(
      renderer.normalizeSettings({ ...base, keepCommandsExpanded: false })
        .keepCommandsExpanded,
      false,
    );
    assert.equal(
      main.normalizeSettings({ ...base, keepCommandsExpanded: false })
        .keepCommandsExpanded,
      false,
    );
    for (const value of ["yes", 0, null, undefined, {}]) {
      assert.throws(
        () => renderer.validateSettingsWrite({ keepCommandsExpanded: value }),
        /keepCommandsExpanded is invalid/,
      );
      assert.throws(
        () => renderer.api.setSettings({ keepCommandsExpanded: value }),
        /keepCommandsExpanded is invalid/,
      );
    }
    assert.equal(invoked, 0, "invalid writes must not reach the preload bridge");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("transcript display mode defaults to fully folded and validates its three values", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    const base = { defaultMode: "agent", theme: "light", enterToSend: true };
    assert.equal(renderer.normalizeSettings(base).transcriptDisplayMode, "fully-folded");
    assert.equal(main.normalizeSettings(base).transcriptDisplayMode, "fully-folded");
    for (const mode of ["flat", "command-first", "fully-folded"]) {
      assert.equal(
        renderer.normalizeSettings({ ...base, transcriptDisplayMode: mode }).transcriptDisplayMode,
        mode,
      );
      assert.equal(
        main.normalizeSettings({ ...base, transcriptDisplayMode: mode }).transcriptDisplayMode,
        mode,
      );
      assert.equal(
        renderer.validateSettingsWrite({ ...base, transcriptDisplayMode: mode }).transcriptDisplayMode,
        mode,
      );
    }
    for (const value of ["yes", 0, null, undefined, {}]) {
      assert.throws(
        () => renderer.validateSettingsWrite({ transcriptDisplayMode: value }),
        /transcriptDisplayMode is invalid/,
      );
      assert.throws(
        () => main.validateSettingsWrite({ transcriptDisplayMode: value }),
        /transcriptDisplayMode is invalid/,
      );
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("radial menu preferences normalize per direction and reject unknown actions", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    const base = { defaultMode: "agent", theme: "light", enterToSend: true };
    assert.deepEqual(renderer.normalizeSettings(base).radialMenu, {});
    assert.deepEqual(main.normalizeSettings(base).radialMenu, {});
    const radialMenu = {
      enabled: true,
      up: "copy-last-answer",
      right: "none",
      down: "scroll-bottom",
      left: "scroll-top",
    };
    assert.deepEqual(
      renderer.normalizeSettings({ ...base, radialMenu }).radialMenu,
      radialMenu,
    );
    assert.deepEqual(
      main.normalizeSettings({ ...base, radialMenu }).radialMenu,
      radialMenu,
    );
    assert.equal(
      renderer.validateSettingsWrite({ ...base, radialMenu }).radialMenu.up,
      "copy-last-answer",
    );
    assert.throws(
      () => renderer.validateSettingsWrite({ radialMenu: { up: "nope" } }),
      /radialMenu\.up is invalid/,
    );
    assert.throws(
      () => main.validateSettingsWrite({ radialMenu: { up: "nope" } }),
      /radialMenu\.up is invalid/,
    );
    assert.throws(
      () => renderer.validateSettingsWrite({ radialMenu: { enabled: "yes" } }),
      /radialMenu\.enabled is invalid/,
    );
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("settings write round-trips command folding through the preload boundary", async () => {
  const previousWindow = globalThis.window;
  const calls = [];
  let stored = {
    defaultMode: "agent",
    theme: "light",
    enterToSend: true,
    onboardingDismissed: false,
  };
  globalThis.window = {
    piDesktop: {
      platform: "win32",
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        if (channel === IPC.invoke.settingsGet) {
          return { ok: true, data: structuredClone(stored) };
        }
        if (channel === IPC.invoke.settingsSet) {
          stored = { ...stored, ...structuredClone(payload) };
          return { ok: true, data: undefined };
        }
        throw new Error(`Unexpected settings IPC: ${channel}`);
      },
    },
  };
  try {
    const initial = await renderer.api.getSettings();
    assert.equal(initial.keepCommandsExpanded, true);

    await renderer.api.setSettings({ ...initial, keepCommandsExpanded: false });

    const write = calls.find(({ channel }) => channel === IPC.invoke.settingsSet);
    assert.ok(write, "settings write must cross the preload boundary");
    assert.equal(write.payload.keepCommandsExpanded, false);
    assert.equal(stored.keepCommandsExpanded, false);

    const reread = await renderer.api.getSettings();
    assert.equal(reread.keepCommandsExpanded, false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

const retryFields = ["providerRetryMaxAttempts", "providerRetryInitialDelayMs", "providerRetryFixedDelayMs"];

test("renderer rejects invalid retry overrides before preload mutation", () => {
  const previousWindow = globalThis.window;
  let calls = 0;
  globalThis.window = { piDesktop: { platform: "win32", invoke: async () => { calls++; return { ok: true }; } } };
  try {
    for (const field of retryFields) {
      for (const value of [-1, 1.5, "3", true, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
        assert.throws(() => renderer.api.setSettings({ [field]: value }), {
          errorCode: "INVALID_PARAMS", message: `${field} is invalid`,
        });
      }
      for (const value of [null, 0, 3, Number.MAX_SAFE_INTEGER]) {
        assert.deepEqual(renderer.validateSettingsWrite({ [field]: value }), { [field]: value });
      }
    }
    assert.equal(calls, 0);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("renderer normalizes invalid retry reads to absence without changing valid zero", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    for (const field of retryFields) {
      for (const value of [null, undefined, -1, 0.5, "3", true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const normalized = renderer.normalizeSettings({ [field]: value });
        assert.equal(Object.hasOwn(normalized, field), false);
      }
      for (const value of [0, 3, Number.MAX_SAFE_INTEGER]) {
        assert.equal(renderer.normalizeSettings({ [field]: value })[field], value);
      }
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("native DNS settings default off and survive a renderer/main read-modify-write", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { piDesktop: { platform: "win32" } };
  try {
    for (const networkDns of [
      undefined,
      { mode: "doh" },
      { mode: "system", serverUrl: "https://192.168.1.2/dns-query", allowSystemFallback: true },
    ]) {
      const base = { defaultMode: "agent", theme: "light", enterToSend: true, networkDns };
      const displayed = renderer.normalizeSettings(main.normalizeSettings(base));
      const persisted = main.validateSettingsWrite(renderer.validateSettingsWrite({ ...displayed, theme: "dark" }));
      assert.equal(persisted.networkDns.mode, networkDns?.mode ?? "system");
      if (networkDns?.mode === "doh") {
        assert.equal(persisted.networkDns.serverUrl, "https://1.1.1.1/dns-query");
        assert.equal(persisted.networkDns.allowSystemFallback, false);
      } else if (networkDns) {
        assert.deepEqual(persisted.networkDns, networkDns);
      }
      assert.equal(persisted.theme, "dark");
    }
    assert.equal(Object.hasOwn(renderer.validateSettingsWrite({ theme: "dark" }), "networkDns"), false);
    assert.equal(Object.hasOwn(main.validateSettingsWrite({ theme: "dark" }), "networkDns"), false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("native DNS rejects invalid writes and normalizes malformed saved data without enabling DNS", () => {
  const previousWindow = globalThis.window;
  let invoked = 0;
  globalThis.window = { piDesktop: { platform: "win32", invoke: async () => { invoked++; return { ok: true }; } } };
  try {
    for (const networkDns of [
      true, [], { mode: "unknown" },
      { mode: "doh", serverUrl: "http://resolver.invalid/dns-query" },
      { mode: "doh", serverUrl: "https://user:password@resolver.invalid/dns-query" },
      { mode: "doh", allowSystemFallback: "true" },
    ]) {
      assert.throws(() => renderer.validateSettingsWrite({ networkDns }), { errorCode: "INVALID_PARAMS" });
      assert.throws(() => renderer.api.setSettings({ networkDns }), { errorCode: "INVALID_PARAMS" });
      assert.throws(() => main.validateSettingsWrite({ networkDns }), { errorCode: "INVALID_PARAMS" });
      assert.deepEqual(main.normalizeSettings({ networkDns }).networkDns, { mode: "system" });
      assert.deepEqual(renderer.normalizeSettings({ networkDns }).networkDns, { mode: "system" });
    }
    assert.equal(invoked, 0, "invalid DNS must not reach the preload boundary");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
