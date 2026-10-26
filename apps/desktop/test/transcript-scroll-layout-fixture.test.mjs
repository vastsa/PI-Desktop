import assert from "node:assert/strict";
import test from "node:test";
import { waitForScrollLayout } from "../../../scripts/e2e/wait-for-scroll-layout.ts";

function fixture(advance = () => {}) {
  let frames = 0;
  const animations = [];
  const scroller = {
    scrollTop: 200, scrollHeight: 1_000, clientHeight: 400,
    getAnimations: () => animations,
  };
  return {
    scroller, animations,
    frames: () => frames,
    nextFrame: async () => { frames++; advance(frames, scroller, animations); },
  };
}
const animation = (endTime, playState = "running", pending = false) => ({
  pending, playState, effect: { getComputedTiming: () => ({ endTime }) },
});

test("reading baseline waits for finite disclosure motion even when geometry is temporarily unchanged", async () => {
  const state = fixture((frame, scroller, animations) => {
    if (frame === 5) {
      scroller.scrollHeight -= 300;
      scroller.scrollTop = 180;
      animations[0].playState = "finished";
    }
  });
  state.animations.push(animation(200));
  await waitForScrollLayout(state.scroller, state.nextFrame);
  assert.equal(state.frames(), 7);
  assert.equal(state.scroller.scrollTop, 180);
});

test("pending finite motion also blocks the baseline", async () => {
  const state = fixture((frame, _scroller, animations) => {
    if (frame === 5) animations[0].pending = false;
  });
  state.animations.push(animation(200, "idle", true));
  await waitForScrollLayout(state.scroller, state.nextFrame);
  assert.equal(state.frames(), 7);
});

test("smooth scroll and resize corrections restart the stability window", async () => {
  const state = fixture((frame, scroller) => {
    if (frame <= 4) scroller.scrollTop += 10;
    if (frame === 5) scroller.scrollHeight += 40;
    if (frame === 6) scroller.clientHeight -= 20;
  });
  await waitForScrollLayout(state.scroller, state.nextFrame);
  assert.equal(state.frames(), 8);
});

test("infinite activity indicators and finished finite animations do not block reading", async () => {
  const state = fixture();
  state.animations.push(animation(Infinity), animation(200, "finished"));
  await waitForScrollLayout(state.scroller, state.nextFrame);
  assert.equal(state.frames(), 3);
});

test("a stalled layout fails with geometry diagnostics instead of accepting a baseline", async () => {
  const state = fixture();
  state.animations.push(animation(200));
  await assert.rejects(waitForScrollLayout(state.scroller, state.nextFrame, 0),
    /Scroll layout did not settle: geometry=200,1000,400, finiteMotion=true/);
});
