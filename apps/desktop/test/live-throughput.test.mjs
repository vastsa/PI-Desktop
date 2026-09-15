import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  LIVE_THROUGHPUT_MIN_SPAN_MS,
  LIVE_THROUGHPUT_STALE_MS,
  LIVE_THROUGHPUT_WINDOW_MS,
  liveTokenRate,
  pushThroughputSample,
  sampleTokensForMessage,
} = await import("../src/lib/live-throughput.ts");

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
  assert.deepEqual(second, [
    { ts: 1_000, tokens: 10 },
    { ts: 2_000, tokens: 40 },
  ]);

  // The 1_000 sample falls outside a 3s window that ends at 4_500.
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

test("a rate needs a span and a positive token delta", () => {
  assert.deepEqual(liveTokenRate([], 5_000), { stale: false });
  assert.deepEqual(liveTokenRate([{ ts: 1_000, tokens: 10 }], 1_000), {
    stale: false,
  });

  // Span shorter than the minimum: too little data to show a number yet.
  const tooShort = [
    { ts: 1_000, tokens: 10 },
    { ts: 1_000 + LIVE_THROUGHPUT_MIN_SPAN_MS - 100, tokens: 60 },
  ];
  assert.equal(liveTokenRate(tooShort, tooShort[1].ts).rate, undefined);

  // A stalled stream reports no rate for the window rather than zero.
  const flat = [
    { ts: 1_000, tokens: 40 },
    { ts: 3_000, tokens: 40 },
  ];
  assert.equal(liveTokenRate(flat, 3_000).rate, undefined);
});

test("the rate divides the windowed token delta by the windowed span", () => {
  const samples = [
    { ts: 1_000, tokens: 100 },
    { ts: 3_000, tokens: 260 },
  ];
  // 160 tokens over 2s.
  assert.equal(liveTokenRate(samples, 3_000).rate, 80);
});

test("the rate ignores growth before the window and stays integral", () => {
  // Only the last two samples are inside a 3s window ending at 10_000, so the
  // early burst must not inflate the live figure.
  const samples = [
    { ts: 1_000, tokens: 0 },
    { ts: 7_500, tokens: 5_000 },
    { ts: 10_000, tokens: 5_050 },
  ];
  const rate = liveTokenRate(samples, 10_000).rate;
  assert.equal(rate, 20);
  assert.equal(Number.isInteger(rate), true);
});

test("silence past the stale threshold dims without discarding the rate", () => {
  const samples = [
    { ts: 1_000, tokens: 100 },
    { ts: 3_000, tokens: 260 },
  ];
  const fresh = liveTokenRate(samples, 3_000 + LIVE_THROUGHPUT_STALE_MS - 100);
  assert.deepEqual(fresh, { rate: 80, stale: false });

  const stale = liveTokenRate(samples, 3_000 + LIVE_THROUGHPUT_STALE_MS + 100);
  assert.equal(stale.stale, true);
  assert.equal(stale.rate, 80);
});
