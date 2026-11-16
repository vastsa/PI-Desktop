import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_LAUNCHER_STATE,
  LAUNCHER_PIN_LIMIT,
  LAUNCHER_RECENT_LIMIT,
  launcherTriggerKey,
  pruneLauncherState,
  readLauncherState,
  rememberLauncherUse,
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

  assert.deepEqual(state, EMPTY_LAUNCHER_STATE);
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

test("pinning appends once and unpinning removes the entry", () => {
  const storage = fakeStorage();

  withStorage(storage, () => {
    setLauncherPinned("app:a", true);
    setLauncherPinned("app:b", true);
    // Re-pinning an item that is already pinned keeps its place.
    assert.deepEqual(setLauncherPinned("app:a", true).pins, ["app:a", "app:b"]);
    assert.deepEqual(setLauncherPinned("app:b", false).pins, ["app:a"]);
  });
});

test("the pin budget is eight and a full row refuses a ninth pin", () => {
  const storage = fakeStorage();

  assert.equal(LAUNCHER_PIN_LIMIT, 8);

  withStorage(storage, () => {
    for (let index = 0; index < 10; index += 1) {
      setLauncherPinned(`app:${index}`, true);
    }
    const state = readLauncherState();

    assert.equal(state.pins.length, LAUNCHER_PIN_LIMIT);
    assert.deepEqual(
      state.pins,
      Array.from({ length: LAUNCHER_PIN_LIMIT }, (_, index) => `app:${index}`),
    );

    // A full row keeps the pins it has and does not evict the oldest one.
    const afterRefusal = setLauncherPinned("app:extra", true);
    assert.deepEqual(afterRefusal.pins, state.pins);

    // Unpinning frees a slot for the next pin.
    setLauncherPinned("app:0", false);
    assert.deepEqual(setLauncherPinned("app:extra", true).pins, [
      "app:1",
      "app:2",
      "app:3",
      "app:4",
      "app:5",
      "app:6",
      "app:7",
      "app:extra",
    ]);
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

test("pruning forgets recents and pins of items that are gone", () => {
  const storage = fakeStorage();

  withStorage(storage, () => {
    rememberLauncherUse("plugin:gone");
    rememberLauncherUse("app:kept");
    setLauncherPinned("plugin:gone", true);

    const state = pruneLauncherState(["app:kept"]);

    assert.deepEqual(state.recents, ["app:kept"]);
    assert.deepEqual(state.pins, []);
    assert.deepEqual(readLauncherState().recents, ["app:kept"]);
  });
});

test("unreadable persisted state degrades to an empty store", () => {
  const storage = fakeStorage({ [STATE_KEY]: "{not json" });

  const state = withStorage(storage, () => readLauncherState());

  assert.deepEqual(state, EMPTY_LAUNCHER_STATE);
});

test("a legacy payload with aliases is read without them and left untouched", () => {
  const aliases = { "app:wechat": ["聊天"] };
  const storage = fakeStorage({
    [STATE_KEY]: JSON.stringify({
      recents: ["app:wechat"],
      pins: ["app:wechat"],
      aliases,
      disabledPlugins: [],
      disabledTriggers: [],
    }),
  });

  const state = withStorage(storage, () => readLauncherState());

  assert.deepEqual(state, {
    recents: ["app:wechat"],
    pins: ["app:wechat"],
    disabledPlugins: [],
    disabledTriggers: [],
  });
  // Reading is not a migration: the stored payload is not rewritten behind the
  // user's back, so a downgrade still finds its aliases.
  assert.deepEqual(JSON.parse(storage.map.get(STATE_KEY)).aliases, aliases);
});

test("a wrong-shaped payload is sanitized instead of trusted", () => {
  const storage = fakeStorage({
    [STATE_KEY]: JSON.stringify({
      recents: ["app:a", 7, "app:a", ""],
      pins: "nope",
      disabledPlugins: null,
      disabledTriggers: ["calculator::expr", 1],
    }),
  });

  const state = withStorage(storage, () => readLauncherState());

  assert.deepEqual(state.recents, ["app:a"]);
  assert.deepEqual(state.pins, []);
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
