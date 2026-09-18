import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(
  new URL("../src/features/chat/composer/use-session-usage.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

const totalsA = {
  turnCount: 2,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 40,
  cacheWriteTokens: 10,
  totalTokens: 200,
};
const totalsB = {
  turnCount: 7,
  inputTokens: 400,
  outputTokens: 90,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 490,
};

/**
 * The hook's lifecycle without a DOM: React is a slot array plus a list of the
 * effects the last render registered, and the host RPC is a queue of promises
 * the test settles by hand.
 */
function createHarness() {
  const state = { activeSessionId: "a", isRunning: false, messages: [] };
  const requests = [];
  const cells = [];
  const committed = [];
  let pending = [];
  let cursor = 0;

  const modules = {
    react: {
      useState: (initial) => {
        const index = cursor++;
        if (!(index in cells)) cells[index] = initial;
        return [
          cells[index],
          (value) => {
            cells[index] =
              typeof value === "function" ? value(cells[index]) : value;
          },
        ];
      },
      useEffect: (effect, deps) => {
        pending.push({ index: cursor++, effect, deps });
      },
    },
    "../../../lib/api": {
      api: {
        getSessionUsage: (sessionId) =>
          new Promise((resolve) => {
            requests.push({ sessionId, resolve, settled: false });
          }),
      },
    },
    "../../../stores/app-store": { useAppStore: (select) => select(state) },
  };

  const exports = {};
  runInNewContext(compiled, {
    exports,
    require: (id) => {
      assert.ok(Object.hasOwn(modules, id), `unmocked dependency: ${id}`);
      return modules[id];
    },
  });

  return {
    state,
    requests,
    /** One render, returning what the composer would hand the inspector. */
    render() {
      cursor = 0;
      pending = [];
      return exports.useSessionUsage();
    },
    // React reruns an effect only when its dependency list changed, and it
    // cleans the previous run up first: same here, so the cancellation guard
    // is exercised exactly as it is in the renderer.
    flush() {
      for (const { index, effect, deps } of pending) {
        const previous = committed[index];
        if (
          previous &&
          previous.deps.length === deps.length &&
          previous.deps.every((value, position) =>
            Object.is(value, deps[position]),
          )
        ) {
          continue;
        }
        previous?.cleanup?.();
        committed[index] = { deps, cleanup: effect() };
      }
    },
    async respond(sessionId, totals) {
      const request = requests.find(
        (entry) => entry.sessionId === sessionId && !entry.settled,
      );
      assert.ok(request, `no pending usage request for ${sessionId}`);
      request.settled = true;
      request.resolve(totals);
      // The hook's `.then` is a microtask chain; let all of it run.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("the session aggregate is bound to the session it was read for", async () => {
  const harness = createHarness();

  // Session A, idle: its totals load and reach the inspector.
  assert.equal(harness.render(), undefined);
  harness.flush();
  await harness.respond("a", totalsA);
  assert.equal(harness.render(), totalsA);
  harness.flush();
  assert.equal(harness.requests.length, 1, "an unchanged render does not refetch");

  // A's next turn just ended, so a refresh for A is in flight…
  harness.state.messages.push({ id: "m1" });
  harness.render();
  harness.flush();
  assert.equal(harness.requests.length, 2);

  // …and the user switches to a running session. Nothing is read while that
  // run is live, and, above all, A's total must not sit over B's conversation
  // as if it were B's own.
  harness.state.activeSessionId = "b";
  harness.state.isRunning = true;
  assert.equal(harness.render(), undefined);
  harness.flush();
  assert.equal(harness.requests.length, 2);

  // The late answer to A's refresh resolves after the switch. It is cancelled
  // with the effect that asked for it, so B never sees it.
  await harness.respond("a", totalsA);
  assert.equal(harness.render(), undefined);

  // B finishes: the aggregate is read again, for B, and shown.
  harness.state.isRunning = false;
  assert.equal(harness.render(), undefined);
  harness.flush();
  await harness.respond("b", totalsB);
  assert.equal(harness.render(), totalsB);
  assert.equal(harness.requests.at(-1).sessionId, "b");
});

test("the run going idle refreshes the aggregate for the active session", async () => {
  const harness = createHarness();

  // Nothing is read while a run is live: the host total would be the turns
  // that finished before it, presented as the session's own.
  harness.state.isRunning = true;
  assert.equal(harness.render(), undefined);
  harness.flush();
  assert.equal(harness.requests.length, 0);

  // Once it is idle the aggregate is read, for the session on screen.
  harness.state.isRunning = false;
  assert.equal(harness.render(), undefined);
  harness.flush();
  assert.equal(harness.requests.length, 1);
  await harness.respond("a", totalsA);
  assert.equal(harness.render(), totalsA);

  // A second idle render with the same dependencies reuses the value instead
  // of refetching it.
  assert.equal(harness.render(), totalsA);
  harness.flush();
  assert.equal(harness.requests.length, 1);
});
