/** Jev's check/store/configure ordering, independent of React and IPC. */
import assert from "node:assert/strict";
import test from "node:test";
import { addJevService, removeJevService } from "../src/components/settings/jev-config.ts";

const KEY = "system-one-fixture-key";
const BINDING = {
  baseUrl: "https://openrouter.test/api/v1",
  modelId: "~typesafe/jev-latest",
};

function deps({ check = { ok: true, status: 200 }, failStore = false } = {}) {
  const log = [];
  return {
    log,
    config: {
      probe: async (key, binding) => {
        log.push(["probe", key, binding]);
        return check;
      },
      storeKey: async (key) => {
        log.push(["store", key]);
        if (failStore) throw new Error("secret store unavailable");
      },
      deleteKey: async () => {
        log.push(["delete"]);
      },
      configure: async (binding) => {
        log.push(["configure", binding]);
      },
      disableAndClear: async () => {
        log.push(["disable-and-clear"]);
      },
    },
  };
}

test("a key that answered is stored, then its binding is enabled", async () => {
  const { log, config } = deps();
  const outcome = await addJevService(config, `  ${KEY}  `, BINDING);

  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(log, [
    ["probe", KEY, BINDING],
    ["store", KEY],
    ["configure", BINDING],
  ]);
});

test("a blank key is never probed and never stored", async () => {
  const { log, config } = deps();
  assert.deepEqual(await addJevService(config, "   ", BINDING), {
    ok: false,
    reason: "missing-key",
  });
  assert.deepEqual(log, []);
});

test("a check the user closed the dialog on is cancelled, not stored", async () => {
  const { log, config } = deps();
  const controller = new AbortController();
  config.probe = async (key, binding) => {
    log.push(["probe", key, binding]);
    controller.abort();
    return { ok: true, status: 200 };
  };
  const outcome = await addJevService(config, KEY, BINDING, controller.signal);

  assert.deepEqual(outcome, { ok: false, reason: "cancelled" });
  assert.deepEqual(log, [["probe", KEY, BINDING]]);
});

test("a refused key is reported and nothing is written", async () => {
  const { log, config } = deps({
    check: { ok: false, status: 401, message: "System One returned 401" },
  });
  const outcome = await addJevService(config, KEY, BINDING);

  assert.deepEqual(outcome, {
    ok: false,
    reason: "check-failed",
    status: 401,
    message: "System One returned 401",
  });
  assert.deepEqual(log, [["probe", KEY, BINDING]]);
});

test("a store failure surfaces before settings can enable the classifier", async () => {
  const { log, config } = deps({ failStore: true });
  await assert.rejects(
    () => addJevService(config, KEY, BINDING),
    /secret store unavailable/,
  );
  assert.deepEqual(log, [
    ["probe", KEY, BINDING],
    ["store", KEY],
  ]);
});

test("a settings failure disables, clears, and removes the newly stored key", async () => {
  const { log, config } = deps();
  config.configure = async (binding) => {
    log.push(["configure", binding]);
    throw new Error("settings unavailable");
  };
  await assert.rejects(
    () => addJevService(config, KEY, BINDING),
    /settings unavailable/,
  );
  assert.deepEqual(log, [
    ["probe", KEY, BINDING],
    ["store", KEY],
    ["configure", BINDING],
    ["disable-and-clear"],
    ["delete"],
  ]);
});

test("removing Jev disables and clears the binding before deleting the key", async () => {
  const { log, config } = deps();
  await removeJevService(config);
  assert.deepEqual(log, [["disable-and-clear"], ["delete"]]);
});
