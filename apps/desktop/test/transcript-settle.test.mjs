import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  TRANSCRIPT_SETTLE_MAX_MS,
  TRANSCRIPT_SETTLE_STABLE_FRAMES,
  TRANSCRIPT_SKELETON_ROWS,
  createTranscriptSettleState,
  reduceTranscriptSettle,
} from "../src/lib/transcript-settle.ts";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [transcript, shell] = await Promise.all([
  read("../src/components/ChatTranscript.tsx"),
  read("../src/styles/chat-shell.css"),
]);

function run(samples, { frameMs = 16 } = {}) {
  let state = createTranscriptSettleState(0);
  let step = null;
  samples.forEach((scrollHeight, index) => {
    step = reduceTranscriptSettle(
      state,
      { scrollHeight, clientHeight: 600 },
      (index + 1) * frameMs,
    );
    state = step.state;
  });
  return step;
}

test("settle waits for the scroller geometry to hold for consecutive frames", () => {
  // Expansion, then two late row-height corrections, then steady.
  const moving = run([4000, 9000, 9120, 9140]);
  assert.equal(moving.settled, false);
  assert.equal(moving.state.stableFrames, 0);

  const steadyFrames = Array.from(
    { length: TRANSCRIPT_SETTLE_STABLE_FRAMES },
    () => 9140,
  );
  const settled = run([4000, 9000, 9120, 9140, ...steadyFrames]);
  assert.equal(settled.settled, true);
  assert.equal(settled.reason, "stable");

  const oneShort = run([4000, 9000, 9120, 9140, ...steadyFrames.slice(1)]);
  assert.equal(oneShort.settled, false, "one frame short of the run must keep waiting");
});

test("a change in client height resets the stable run", () => {
  let state = createTranscriptSettleState(0);
  const at = (scrollHeight, clientHeight, now) => {
    const step = reduceTranscriptSettle(state, { scrollHeight, clientHeight }, now);
    state = step.state;
    return step;
  };
  at(9000, 600, 16);
  at(9000, 600, 32);
  assert.equal(state.stableFrames, 1);
  at(9000, 580, 48);
  assert.equal(state.stableFrames, 0, "a resized viewport is a moved bottom");
});

test("settle always lifts at the time cap even while the geometry keeps moving", () => {
  const frames = Math.ceil(TRANSCRIPT_SETTLE_MAX_MS / 16) + 1;
  const growing = Array.from({ length: frames }, (_, index) => 4000 + index * 7);
  const step = run(growing);
  assert.equal(step.settled, true);
  assert.equal(step.reason, "timeout");

  const early = run(growing.slice(0, frames - 2));
  assert.equal(early.settled, false, "the cap is a ceiling, not the normal path");
});

test("the skeleton reads as a conversation tail", () => {
  assert.ok(TRANSCRIPT_SKELETON_ROWS.length >= 4);
  assert.ok(TRANSCRIPT_SKELETON_ROWS.some((row) => row.role === "user"));
  assert.ok(TRANSCRIPT_SKELETON_ROWS.some((row) => row.role === "assistant"));
  for (const row of TRANSCRIPT_SKELETON_ROWS) {
    assert.ok(row.lines.length > 0);
    for (const width of row.lines) assert.match(width, /^\d+%$/);
  }
});

test("a long transcript mounts under the settle veil and lifts it from measured geometry", () => {
  // The veil is decided in the same render as the bounded first commit, so it is
  // in the frame that reveals the pane rather than one frame later.
  assert.match(
    transcript,
    /useState<"covering" \| "leaving" \| "off">\(\s*\(\) => \(hydrationBounded \? "covering" : "off"\),?\s*\)/,
  );
  // Sampling starts only after the expansion commit and pauses for hidden panes.
  assert.match(
    transcript,
    /if \(!veilCovering \|\| hydrationBounded \|\| !paneVisible\) return;/,
  );
  assert.match(transcript, /createTranscriptSettleState\(performance\.now\(\)\)/);
  assert.match(
    transcript,
    /reduceTranscriptSettle\(\s*state,\s*\{ scrollHeight: el\.scrollHeight, clientHeight: el\.clientHeight \},/,
  );
  // Every sample re-pins a pinned transcript, so the reveal frame is at the tail.
  assert.match(
    transcript,
    /const sample = \(\) => \{\s*frame = 0;\s*if \(pinnedRef\.current\) scrollToBottom\(\);/,
  );
  assert.match(transcript, /if \(step\.settled\) \{\s*setVeilPhase\("leaving"\);/);
  assert.match(transcript, /setVeilPhase\("off"\),\s*TRANSCRIPT_VEIL_FADE_MS/);
  // Markup: veil with skeleton rows, and controls that measure or float over the
  // transcript wait for it to lift.
  assert.match(transcript, /className="transcript-settle-veil"[\s\S]*?data-phase=\{veilPhase\}/);
  assert.match(transcript, /aria-label=\{t\("chat\.loadingSession"\)\}/);
  assert.match(transcript, /TRANSCRIPT_SKELETON_ROWS\.map/);
  assert.match(transcript, /data-transcript-settling=\{veilCovering \? "true" : undefined\}/);
  assert.match(transcript, /\{paneVisible && !veilCovering \? \(\s*<ConversationMinimap/);
  assert.match(transcript, /\{showJump && !veilCovering \? \(/);
  // Stylesheet: opaque cover, fade on leave, no z-index so the composer stays on
  // top, reduced motion honoured.
  const veil = shell.match(/\.transcript-settle-veil \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(veil, "veil rule missing");
  assert.match(veil, /position: absolute;/);
  assert.match(veil, /inset: 0;/);
  assert.match(veil, /background: var\(--ds-bg-primary\);/);
  assert.doesNotMatch(veil, /z-index/);
  assert.match(shell, /\.transcript-settle-veil\[data-phase="leaving"\] \{\s*opacity: 0;/);
  assert.match(
    shell,
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.transcript-skeleton-line \{\s*animation: none;/,
  );
});

test("pinned follow re-pins inside the resize observer, on the border box", () => {
  // A frame requested from a ResizeObserver callback lands in the next frame,
  // so the grown content painted unpinned once. Re-pinning inside the callback
  // (after layout, before paint) removes that frame.
  assert.match(
    transcript,
    /const followScrollNow = useCallback\(\(\) => \{\s*if \(!paneVisibleRef\.current \|\| !pinnedRef\.current\) return;\s*cancelFollowScroll\(\);\s*scrollToBottom\(\);/,
  );
  assert.match(transcript, /new ResizeObserver\(followScrollNow\)/);
  assert.doesNotMatch(transcript, /new ResizeObserver\(scheduleFollowScroll\)/);
  // The composer publishes its height as the content's bottom padding; only the
  // border box sees that change. The scroller's own box covers window resizes.
  assert.match(transcript, /ro\.observe\(content, \{ box: "border-box" \}\)/);
  assert.match(transcript, /ro\.observe\(scroller, \{ box: "border-box" \}\)/);
});
