import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { subscribePluginCatalogRefresh } from "../src/features/app/plugin-catalog-refresh.ts";

test("background plugin refresh reports host failure and recovers on the next notification", async (t) => {
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  let listener;
  let available = false;
  let visiblePlugins = ["retained-plugin"];
  const failure = new Error("host-core is unavailable");
  const unsubscribe = subscribePluginCatalogRefresh(
    (callback) => {
      listener = callback;
      return () => { listener = undefined; };
    },
    async () => {
      if (!available) throw failure;
      visiblePlugins = ["reloaded-plugin"];
    },
  );
  try {
    await setImmediate();
    assert.deepEqual(visiblePlugins, ["retained-plugin"]);
    assert.equal(warnings.length, 1, "background failure must be observed rather than left unhandled");
    assert.equal(warnings[0][1], failure);
    available = true;
    listener();
    await setImmediate();
    assert.deepEqual(visiblePlugins, ["reloaded-plugin"]);
    assert.equal(warnings.length, 1);
    available = false;
    listener();
    await setImmediate();
    assert.deepEqual(visiblePlugins, ["reloaded-plugin"]);
    assert.equal(warnings.length, 2, "later notifications use the same rejection boundary");
  } finally {
    unsubscribe();
  }
  assert.equal(listener, undefined, "unmount must remove the subscription");
});
