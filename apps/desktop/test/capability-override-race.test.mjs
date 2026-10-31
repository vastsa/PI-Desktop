import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
// The react alias must be registered so the hook module's "react" import
// resolves to the minimal runtime; ts-import-hooks then handles the
// extensionless relative imports.
register(new URL("./helpers/react-alias-hooks.mjs", import.meta.url));
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
globalThis.window = { piDesktop: undefined };
const { useHostCollection } = await import("../src/hooks/use-host-collection.ts");
const stub = await import("./helpers/react-hook-stub.mjs");

const empty = { global: [], project: [], statuses: [], globalOverrides: {} };

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a late stale project fetch cannot repaint the accepted project's overrides", async () => {
  // #1964 review round three: the override map used to live in its own state,
  // written from inside the fetcher before the generation check, so a slow A
  // fetch landing after the reader had switched to B repainted B's badges with
  // A's overrides - and reversing the pair hid B's real mismatch entirely.
  // Overrides now ride inside the collection, so the guard rejects them
  // wholesale together with the rows they were derived from.
  const collectionA = {
    global: [{ id: "s", enabled: true }],
    project: [],
    statuses: [],
    globalOverrides: { s: "off" },
  };
  const collectionB = {
    global: [{ id: "s", enabled: true }],
    project: [],
    statuses: [],
    globalOverrides: {},
  };

  // One fetcher identity per project, exactly like the page's useCallback.
  let fetcher = () => new Promise((resolve) => {
    window.__resolveA = resolve;
  });
  let view = stub.__mount(() => useHostCollection(fetcher, empty, () => {}));
  assert.notEqual(window.__resolveA, undefined, "project A's fetch should be in flight");

  // The reader switches to project B: a new fetcher identity, a new request
  // generation; the effect cleanup retires everything before it.
  fetcher = () => Promise.resolve(collectionB);
  view = stub.__render(() => useHostCollection(fetcher, empty, () => {}));
  await flush();
  view = stub.__render(() => useHostCollection(fetcher, empty, () => {}));
  assert.deepEqual(view.data, collectionB);

  // A lands late. The accepted collection must stay B's, overrides included.
  window.__resolveA(collectionA);
  await flush();
  view = stub.__render(() => useHostCollection(fetcher, empty, () => {}));
  assert.deepEqual(view.data, collectionB, "the stale collection must be rejected");
  assert.deepEqual(view.data.globalOverrides, {}, "B shows no overrides after A lands late");
});

test("the newest generation still wins when it finishes after an older one", async () => {
  const collectionA = {
    global: [],
    project: [],
    statuses: [],
    globalOverrides: { s: "on" },
  };
  let fetcher = () => Promise.resolve(empty);
  let view = stub.__mount(() => useHostCollection(fetcher, empty, () => {}));
  await flush();
  view = stub.__render(() => useHostCollection(fetcher, empty, () => {}));
  assert.deepEqual(view.data, empty);

  fetcher = () => Promise.resolve(collectionA);
  view = stub.__render(() => useHostCollection(fetcher, empty, () => {}));
  await flush();
  view = stub.__render(() => useHostCollection(fetcher, empty, () => {}));
  assert.deepEqual(view.data, collectionA);
});
