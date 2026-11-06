import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createTranscriptLatestNavigation } = await import("../src/lib/transcript-latest-navigation.ts");

function fixture(reduced = false) {
  const box = { scrollTop: 80, scrollHeight: 8000, clientHeight: 600 };
  const frames = new Map();
  const positions = [];
  let now = 0;
  let id = 0;
  let arrivals = 0;
  let contentShift = 0;
  const navigation = createTranscriptLatestNavigation({
    geometry: () => box,
    captureAnchor: () => ({ top: contentShift, measure: () => contentShift }),
    move: top => { box.scrollTop = top; positions.push(top); },
    request: callback => { frames.set(++id, callback); return id; },
    cancel: id => frames.delete(id),
    now: () => now,
    reducedMotion: () => reduced,
  });
  const advance = (elapsed = 16) => {
    now += elapsed;
    const batch = [...frames.values()];
    frames.clear();
    for (const frame of batch) frame(now);
  };
  const finish = () => { for (let n = 0; navigation.isActive() && n < 60; n++) advance(); };
  return { box, navigation, positions, frames, advance, finish,
    start: () => navigation.start(() => arrivals++), arrivals: () => arrivals,
    shiftAbove: delta => { contentShift += delta; box.scrollHeight += delta; } };
}

test("latest moves continuously to bottom before committing the new view", () => {
  const f = fixture();
  f.start();
  assert.equal(f.box.scrollTop, 80);
  f.advance();
  assert(f.box.scrollTop > 80 && f.box.scrollTop < 7400);
  assert.equal(f.arrivals(), 0);
  f.finish();
  assert(f.positions.length >= 8);
  assert(f.positions.every((top, i) => i === 0 || top >= f.positions[i - 1]));
  assert.equal(f.box.scrollTop, 7400);
  assert.equal(f.arrivals(), 1);
  assert.equal(f.frames.size, 0);
});

test("late stream growth retargets the trip without reversing or losing bottom", () => {
  const f = fixture();
  f.start(); f.advance();
  f.box.scrollHeight += 800;
  f.finish();
  assert(f.positions.every((top, i) => i === 0 || top >= f.positions[i - 1]));
  assert.equal(f.box.scrollTop, 8200);
  assert.equal(f.arrivals(), 1);
});

test("a late changes card below the reader retargets without an instantaneous height jump", () => {
  const baseline = fixture();
  const changed = fixture();
  baseline.start(); changed.start();
  baseline.advance(); changed.advance();
  changed.box.scrollHeight += 37;
  baseline.advance(0); changed.advance(0);
  assert.equal(changed.box.scrollTop, baseline.box.scrollTop,
    "footer growth is a new destination, not displacement above visible text");
  baseline.advance(); changed.advance();
  assert(changed.box.scrollTop - baseline.box.scrollTop < 37);
  changed.finish();
  assert.equal(changed.box.scrollTop, 7437);
  assert.equal(changed.arrivals(), 1);
});

test("reader interruption retires every queued frame without committing latest", () => {
  const f = fixture();
  f.start(); f.advance();
  const top = f.box.scrollTop;
  f.navigation.cancel(); f.advance();
  assert.equal(f.box.scrollTop, top);
  assert.equal(f.arrivals(), 0);
  assert.equal(f.navigation.isActive(), false);
  assert.equal(f.frames.size, 0);
});

test("pane hide commits accepted latest intent once without finishing an invisible animation", () => {
  const f = fixture();
  f.start(); f.advance(); f.navigation.cancel(true); f.navigation.cancel(true); f.advance();
  assert.equal(f.arrivals(), 1);
  assert.equal(f.frames.size, 0);
});

test("repeated navigation cannot commit an obsolete trip", () => {
  const f = fixture();
  f.start(); f.advance(); f.start(); f.finish();
  assert.equal(f.arrivals(), 1);
});

test("reduced motion reaches bottom synchronously", () => {
  const f = fixture(true);
  f.start();
  assert.equal(f.box.scrollTop, 7400);
  assert.equal(f.arrivals(), 1);
  assert.equal(f.frames.size, 0);
});

for (const delta of [2400, -1200]) {
  test(`layout above the reader (${delta}px) does not alter latest's visible trajectory`, () => {
    const baseline = fixture();
    const changed = fixture();
    baseline.start(); changed.start();
    baseline.advance(); changed.advance();
    changed.shiftAbove(delta);
    baseline.advance(); changed.advance();
    const remaining = f => f.box.scrollHeight - f.box.clientHeight - f.box.scrollTop;
    assert(Math.abs(remaining(changed) - remaining(baseline)) <= 1,
      `layout must be compensated, not interpolated: ${remaining(changed)} vs ${remaining(baseline)}`);
    baseline.finish(); changed.finish();
    assert.equal(remaining(changed), 0);
    assert.equal(changed.arrivals(), 1);
  });
}
