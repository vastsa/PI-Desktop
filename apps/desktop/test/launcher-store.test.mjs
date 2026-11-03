import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_LAUNCHER_STATE,
  LAUNCHER_ALIAS_LIMIT,
  LAUNCHER_RECENT_LIMIT,
  launcherTriggerKey,
  pruneLauncherState,
  readLauncherState,
  rememberLauncherUse,
  setLauncherAliases,
  setLauncherPinned,
  setLauncherPluginDisabled,
  setLauncherTriggerDisabled,
} from "../src/lib/launcher-store.ts";

const STATE_KEY = "pi.desktop.launcher.state";
const LEGACY_KEY = "pi.desktop.pluginLaunchHistory";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
  };
}

function withStorage(storage, run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
}

test("plugin history written by the previous panel survives the upgrade", () => {
  const storage = fakeStorage({
    [LEGACY_KEY]: JSON.stringify([
      { id: "pi.file-manager", usedAt: 200 },
      { id: "pi.browser", usedAt: 100 },
    ]),
  });

  const state = withStorage(storage, () => readLauncherState());

  assert.deepEqual(state.recents, ["plugin:pi.file-manager", "plugin:pi.browser"]);
});

test("an empty store reports nothing pinned or disabled", () => {
  const state = withStorage(fakeStorage(), () => readLauncherState());

  assert.deepEqual(state.pins, []);
  assert.deepEqual(state.aliases, {});
  assert.deepEqual(state.disabledPlugins, []);
  assert.deepEqual(state.disabledTriggers, []);
});

test("opening an item moves it to the front exactly once", () => {
  const storage = fakeStorage();

  withStorage(storage, () => {
    rememberLauncherUse("app:a");
    rememberLauncherUse("app:b");
    const state = rememberLauncherUse("app:a");

    assert.deepEqual(state.recents, ["app:a", "app:b"]);
  });
});

test("recents stay capped", () => {
  const storage = fakeStorage();

  withStorage(storage, () => {
    for (let index = 0; index < LAUNCHER_RECENT_LIMIT + 10; index += 1) {
      rememberLauncherUse(`app:${index}`);
    }
    const state = readLauncherState();

    assert.equal(state.recents.length, LAUNCHER_RECENT_LIMIT);
    assert.equal(state.recents[0], `app:${LAUNCHER_RECENT_LIMIT + 9}`);
  });
});

test("pinning is idempotent and unpinning removes the entry", () => {
  const storage = fakeStorage();

  withStorage(storage, () => {
    setLauncherPinned("app:a", true);
    setLauncherPinned("app:b", true);
    assert.deepEqual(setLauncherPinned("app:a", true).pins, ["app:b", "app:a"]);
    assert.deepEqual(setLauncherPinned("app:b", false).pins, ["app:a"]);
  });
});

test("aliases are trimmed, deduplicated and capped", () => {
  const storage = fakeStorage();
  const aliases = Array.from(
    { length: LAUNCHER_ALIAS_LIMIT + 4 },
    (_, index) => ` alias ${index} `,
  );

  withStorage(storage, () => {
    const state = setLauncherAliases("app:wechat", ["微信", "微信", ...aliases]);

    assert.deepEqual(state.aliases["app:wechat"], [
      "微信",
      ...aliases.slice(0, LAUNCHER_ALIAS_LIMIT - 1).map((alias) => alias.trim()),
    ]);
  });
});

test("clearing every alias drops the item key", () => {
  const storage = fakeStorage();

  withStorage(storage, () => {
    setLauncherAliases("app:wechat", ["微信"]);
    const state = setLauncherAliases("app:wechat", ["   "]);

    assert.equal("app:wechat" in state.aliases, false);
  });
});

test("trigger preferences are namespaced by plugin", () => {
  const storage = fakeStorage();

  withStorage(storage, () => {
    const state = setLauncherTriggerDisabled("calculator", "expr", true);

    assert.deepEqual(state.disabledTriggers, [launcherTriggerKey("calculator", "expr")]);
    assert.deepEqual(
      setLauncherTriggerDisabled("calculator", "expr", false).disabledTriggers,
      [],
    );
  });
});

test("a plugin hidden from the launcher keeps that preference through pruning", () => {
  const storage = fakeStorage();

  withStorage(storage, () => {
    setLauncherPluginDisabled("noisy", true);
    const state = pruneLauncherState(["plugin:quiet"]);

    assert.deepEqual(state.disabledPlugins, ["noisy"]);
  });
});

test("pruning forgets recents, pins and aliases of items that are gone", () => {
  const storage = fakeStorage();

  withStorage(storage, () => {
    rememberLauncherUse("plugin:gone");
    rememberLauncherUse("app:kept");
    setLauncherPinned("plugin:gone", true);
    setLauncherAliases("plugin:gone", ["x"]);

    const state = pruneLauncherState(["app:kept"]);

    assert.deepEqual(state.recents, ["app:kept"]);
    assert.deepEqual(state.pins, []);
    assert.deepEqual(state.aliases, {});
    assert.deepEqual(readLauncherState().recents, ["app:kept"]);
  });
});

test("unreadable persisted state degrades to an empty store", () => {
  const storage = fakeStorage({ [STATE_KEY]: "{not json" });

  const state = withStorage(storage, () => readLauncherState());

  assert.deepEqual(state, EMPTY_LAUNCHER_STATE);
});

test("a wrong-shaped payload is sanitized instead of trusted", () => {
  const storage = fakeStorage({
    [STATE_KEY]: JSON.stringify({
      recents: ["app:a", 7, "app:a", ""],
      pins: "nope",
      aliases: { "app:a": ["ok", 5], "  ": ["bad"] },
      disabledPlugins: null,
      disabledTriggers: ["calculator::expr", 1],
    }),
  });

  const state = withStorage(storage, () => readLauncherState());

  assert.deepEqual(state.recents, ["app:a"]);
  assert.deepEqual(state.pins, []);
  assert.deepEqual(state.aliases, { "app:a": ["ok"] });
  assert.deepEqual(state.disabledPlugins, []);
  assert.deepEqual(state.disabledTriggers, ["calculator::expr"]);
});

test("a storage that refuses writes does not break the launcher", () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };

  const state = withStorage(storage, () => {
    rememberLauncherUse("app:a");
    return readLauncherState();
  });

  assert.deepEqual(state.recents, []);
});
