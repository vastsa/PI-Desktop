import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  LIVE_THROUGHPUT_MIN_SPAN_MS,
  LIVE_THROUGHPUT_SAMPLE_MS,
  LIVE_THROUGHPUT_STALE_MS,
  LIVE_THROUGHPUT_WINDOW_MS,
  pushThroughputSample,
  retainLiveRate,
  sampleDidGrow,
  sampleTokensForMessage,
  windowedTokenRate,
} = await import("../src/lib/live-throughput.ts");

/**
 * Drive the module the way the hook does: a fixed-cadence sampler that keeps
 * appending whether or not the message grew, and only remembers a figure
 * measured while output was actually arriving.
 */
function runSampler({ from, to, tokensAt, samples = [], remembered }) {
  let current = samples;
  let memory = remembered;
  let live;
  for (let ts = from; ts <= to; ts += LIVE_THROUGHPUT_SAMPLE_MS) {
    current = pushThroughputSample(current, { ts, tokens: tokensAt(ts) });
    live = sampleDidGrow(current) ? windowedTokenRate(current) : undefined;
    if (live !== undefined) memory = { rate: live, at: ts };
  }
  return { view: retainLiveRate(live, memory, to), samples: current, remembered: memory };
}

test("samples count visible thinking plus answer text in code points", () => {
  // ADR 0073 §3 fixes the estimate at four Unicode code points per token, so a
  // surrogate pair counts once rather than twice.
  assert.equal(sampleTokensForMessage({ content: "abcd", thinking: "" }), 1);
  assert.equal(sampleTokensForMessage({ content: "", thinking: "abcd" }), 1);
  assert.equal(sampleTokensForMessage({ content: "ab", thinking: "cd" }), 1);
  assert.equal(sampleTokensForMessage({ content: "😀😀😀😀", thinking: "" }), 1);
  assert.equal(sampleTokensForMessage({ content: "", thinking: "" }), 0);
  assert.equal(sampleTokensForMessage(undefined), 0);
});

test("pushing prunes samples outside the window and never mutates the input", () => {
  const first = pushThroughputSample([], { ts: 1_000, tokens: 10 });
  const second = pushThroughputSample(first, { ts: 2_000, tokens: 40 });
  assert.deepEqual(first, [{ ts: 1_000, tokens: 10 }]);

  // The 1_000 sample falls outside a window that ends at 4_500.
  const pruned = pushThroughputSample(second, {
    ts: 1_000 + LIVE_THROUGHPUT_WINDOW_MS + 500,
    tokens: 90,
  });
  assert.deepEqual(
    pruned.map((sample) => sample.ts),
    [2_000, 4_500],
  );
});

test("pushing keeps one sample already older than the window as the baseline", () => {
  // Pruning must not drop every earlier sample, or a slow stream would never
  // span enough time to produce a rate.
  const samples = pushThroughputSample([{ ts: 0, tokens: 5 }], {
    ts: LIVE_THROUGHPUT_WINDOW_MS * 2,
    tokens: 25,
  });
  assert.equal(samples.length, 2);
  assert.equal(samples[0].ts, 0);
});

test("a measurement needs a span and a positive token delta", () => {
  assert.equal(windowedTokenRate([]), undefined);
  assert.equal(windowedTokenRate([{ ts: 1_000, tokens: 10 }]), undefined);

  const tooShort = [
    { ts: 1_000, tokens: 10 },
    { ts: 1_000 + LIVE_THROUGHPUT_MIN_SPAN_MS - 100, tokens: 60 },
  ];
  assert.equal(windowedTokenRate(tooShort), undefined);

  // A stalled window reports nothing rather than dividing a zero delta.
  assert.equal(
    windowedTokenRate([
      { ts: 1_000, tokens: 40 },
      { ts: 3_000, tokens: 40 },
    ]),
    undefined,
  );
});

test("the measurement divides the windowed delta by the windowed span", () => {
  assert.equal(
    windowedTokenRate([
      { ts: 1_000, tokens: 100 },
      { ts: 3_000, tokens: 260 },
    ]),
    80,
  );
});

test("the measurement ignores growth before the window and stays integral", () => {
  // Only the last two samples sit inside the window, so the early burst must
  // not inflate the live figure.
  const rate = windowedTokenRate([
    { ts: 1_000, tokens: 0 },
    { ts: 7_500, tokens: 5_000 },
    { ts: 10_000, tokens: 5_050 },
  ]);
  assert.equal(rate, 20);
  assert.equal(Number.isInteger(rate), true);
});

test("a fresh measurement wins; nothing shows before the first one", () => {
  assert.deepEqual(retainLiveRate(80, undefined, 5_000), {
    rate: 80,
    stale: false,
  });
  assert.deepEqual(retainLiveRate(80, { rate: 20, at: 0 }, 5_000), {
    rate: 80,
    stale: false,
  });
  assert.deepEqual(retainLiveRate(undefined, undefined, 5_000), {
    stale: false,
  });
});

test("a brief gap holds the figure steady before dimming it", () => {
  const remembered = { rate: 80, at: 1_000 };
  assert.deepEqual(
    retainLiveRate(undefined, remembered, 1_000 + LIVE_THROUGHPUT_STALE_MS - 100),
    { rate: 80, stale: false },
  );
  assert.deepEqual(
    retainLiveRate(undefined, remembered, 1_000 + LIVE_THROUGHPUT_STALE_MS + 100),
    { rate: 80, stale: true },
  );
});

test("only a growing sample counts as generation", () => {
  assert.equal(sampleDidGrow([]), false);
  assert.equal(sampleDidGrow([{ ts: 0, tokens: 10 }]), false);
  assert.equal(
    sampleDidGrow([
      { ts: 0, tokens: 10 },
      { ts: 250, tokens: 10 },
    ]),
    false,
  );
  assert.equal(
    sampleDidGrow([
      { ts: 0, tokens: 10 },
      { ts: 250, tokens: 11 },
    ]),
    true,
  );
});

test("a long tool call holds the streaming rate, dims it, then recovers", () => {
  // The sampler ticks on a timer, so a stalled stream keeps appending samples
  // with identical token counts. A window straddling the moment output stopped
  // still yields truthful but shrinking numbers, so the displayed figure has to
  // be gated on growth — otherwise it sags from 40 toward 0 across the tool
  // call and reads as a crawling model.
  const streaming = runSampler({ from: 0, to: 2_000, tokensAt: (ts) => ts / 25 });
  assert.deepEqual(streaming.view, { rate: 40, stale: false });

  // Ten seconds of tool execution: samples arrive, tokens do not move.
  const stalled = runSampler({
    from: 2_250,
    to: 12_000,
    tokensAt: () => 80,
    samples: streaming.samples,
    remembered: streaming.remembered,
  });
  assert.equal(stalled.view.rate, 40, "the streaming rate survives unchanged");
  assert.equal(stalled.view.stale, true, "and is marked stale so the chip dims");

  // Generation resumes. The figure goes live immediately but ramps rather than
  // jumping: the window still holds part of the idle stretch, so it reports the
  // honest "tokens in the last few seconds" until that stretch scrolls out.
  const resumed = runSampler({
    from: 12_250,
    to: 14_000,
    tokensAt: (ts) => 80 + (ts - 12_000) / 10,
    samples: stalled.samples,
    remembered: stalled.remembered,
  });
  assert.equal(resumed.view.stale, false, "live again as soon as output returns");
  assert.equal(resumed.view.rate, 67);

  const settled = runSampler({
    from: 14_250,
    to: 15_500,
    tokensAt: (ts) => 80 + (ts - 12_000) / 10,
    samples: resumed.samples,
    remembered: resumed.remembered,
  });
  assert.deepEqual(settled.view, { rate: 100, stale: false });
});
