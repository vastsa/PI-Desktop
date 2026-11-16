import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createTranscriptLatestNavigation } = await import("../src/lib/transcript-latest-navigation.ts");

function fixture(reduced = false) {
  const box = { scrollTop: 80, scrollHeight: 8000, clientHeight: 600 };
  const listeners = new Set();
  const moves = [];
  let arrivals = 0;
  let stops = 0;
  const navigation = createTranscriptLatestNavigation({
    geometry: () => box,
    move: (top, behavior) => {
      moves.push({ top, behavior });
      if (behavior === "auto") box.scrollTop = top;
    },
    onScrollEnd: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    stop: () => { stops++; },
    reducedMotion: () => reduced,
  });
  return { box, navigation, moves, listeners,
    start: () => navigation.start(() => arrivals++), arrivals: () => arrivals, stops: () => stops,
    settle: (top = moves.at(-1).top) => {
      box.scrollTop = Math.min(top, box.scrollHeight - box.clientHeight);
      for (const listener of [...listeners]) listener();
    },
  };
}

test("latest delegates movement to browser smooth scroll, just like a turn marker", () => {
  const f = fixture();
  f.start();
  assert.deepEqual(f.moves, [{ top: 7400, behavior: "smooth" }]);
  assert.equal(f.box.scrollTop, 80, "the controller must not simulate animation frames");
  assert.equal(f.arrivals(), 0);
  assert(f.navigation.isActive());
  f.box.scrollTop = 900;
  assert.equal(f.moves.length, 1, "intermediate browser positions need no scroll writes");
  f.settle();
  assert.equal(f.arrivals(), 1);
  assert.equal(f.navigation.isActive(), false);
  assert.equal(f.listeners.size, 0);
});

test("a late changes card extends native travel without an instant height jump", () => {
  const f = fixture();
  f.start();
  f.box.scrollTop = 900;
  f.box.scrollHeight += 56;
  assert.equal(f.moves.length, 1, "layout growth must not interrupt the current browser animation");
  f.settle(7400);
  assert.deepEqual(f.moves.at(-1), { top: 7456, behavior: "smooth" });
  assert.equal(f.box.scrollTop, 7400, "remaining distance is animated, never snapped");
  assert.equal(f.arrivals(), 0);
  f.settle();
  assert.equal(f.arrivals(), 1);
});

test("reader interruption stops native travel and detaches obsolete arrival", () => {
  const f = fixture();
  f.start();
  const obsolete = [...f.listeners][0];
  f.box.scrollTop = 900;
  f.navigation.cancel();
  obsolete();
  assert.equal(f.stops(), 1);
  assert.equal(f.box.scrollTop, 900);
  assert.equal(f.arrivals(), 0);
  assert.equal(f.navigation.isActive(), false);
  assert.equal(f.listeners.size, 0);
});

test("pane hide commits latest intent exactly once and stops invisible native motion", () => {
  const f = fixture();
  f.start();
  f.navigation.cancel(true); f.navigation.cancel(true);
  assert.equal(f.arrivals(), 1);
  assert.equal(f.stops(), 1);
  assert.equal(f.listeners.size, 0);
});

test("a repeated click cannot commit the previous native trip", () => {
  const f = fixture();
  f.start();
  const obsolete = [...f.listeners][0];
  f.start(); obsolete();
  assert.equal(f.arrivals(), 0);
  assert.equal(f.listeners.size, 1);
  f.settle();
  assert.equal(f.arrivals(), 1);
});

test("reduced motion uses the turn marker's immediate auto behavior", () => {
  const f = fixture(true);
  f.start();
  assert.deepEqual(f.moves, [{ top: 7400, behavior: "auto" }]);
  assert.equal(f.box.scrollTop, 7400);
  assert.equal(f.arrivals(), 1);
  assert.equal(f.listeners.size, 0);
});

test("an already-bottomed or hidden scroller does not wait for a nonexistent scrollend", () => {
  for (const hidden of [false, true]) {
    const f = fixture();
    f.box.scrollTop = 7400;
    if (hidden) f.box.clientHeight = 0;
    f.start();
    assert.equal(f.arrivals(), 1);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.navigation.isActive(), false);
  }
});
