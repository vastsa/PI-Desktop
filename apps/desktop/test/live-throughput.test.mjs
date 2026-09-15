import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const {
  advanceThroughput,
  generationPhase,
  smoothTokenRate,
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

test("a long tool call retains the rate and resumed generation gets a fresh baseline", () => {
  let tracker = { samples: [] };
  let view;
  const tick = (now, tokens, generating) => {
    ({ tracker, view } = advanceThroughput(tracker, {
      id: "a", content: "x".repeat(tokens * 4), status: "streaming",
    }, generating, now));
  };
  for (let now = 0; now <= 2000; now += LIVE_THROUGHPUT_SAMPLE_MS) tick(now, now / 25, true);
  assert.deepEqual(view, { rate: 40, stale: false });
  for (let now = 2250; now <= 12000; now += LIVE_THROUGHPUT_SAMPLE_MS) {
    tick(now, 80, false);
    assert.deepEqual(view, { rate: 40, stale: true });
  }
  tick(12250, 80, true);
  assert.deepEqual(view, { rate: 40, stale: true });
  for (let now = 12500; now <= 14000; now += LIVE_THROUGHPUT_SAMPLE_MS) {
    tick(now, 80 + (now - 12250) / 10, true);
  }
  assert.deepEqual(view, { rate: 100, stale: false });
});

test("smoothing is cadence-independent and damps a speed jump", () => {
  const once = smoothTokenRate(40, 100, 500);
  const twice = smoothTokenRate(smoothTokenRate(40, 100, 250), 100, 250);
  assert.ok(Math.abs(once - twice) < 1e-9);
  assert.ok(once > 40 && once < 100);
});

test("tool gaps and message replacement never enter the next generation window", () => {
  let tracker = { samples: [] };
  const msg = (id, tokens) => ({ id, content: "x".repeat(tokens * 4), status: "streaming" });
  for (let now = 0; now <= 1000; now += 250) {
    tracker = advanceThroughput(tracker, msg("a", now / 25), true, now).tracker;
  }
  assert.equal(tracker.remembered.rate, 40);
  const tools = advanceThroughput(tracker, msg("a", 40), false, 1250);
  assert.deepEqual(tools.view, { rate: 40, stale: true });
  const restart = advanceThroughput(tools.tracker, msg("b", 400), true, 20000);
  assert.equal(restart.tracker.samples.length, 1);
  assert.equal(restart.tracker.smoothed, undefined);
  tracker = restart.tracker;
  for (let now = 20250; now <= 21000; now += 250) {
    tracker = advanceThroughput(tracker, msg("b", 400 + (now - 20000) / 50), true, now).tracker;
  }
  assert.equal(tracker.remembered.rate, 20);
});

test("thinking to text keeps the same token and time baseline", () => {
  let tracker = { samples: [] };
  for (let now = 0; now <= 1000; now += 250) {
    const message = { id: "a", thinking: "x".repeat(Math.min(now, 500) / 25 * 4), content: "x".repeat(Math.max(now - 500, 0) / 25 * 4), status: "streaming" };
    tracker = advanceThroughput(tracker, message, true, now).tracker;
  }
  assert.equal(tracker.remembered.rate, 40);
});

test("generation labels distinguish empty, thinking, text and running tools", () => {
  const message = { id: "a", content: "", status: "streaming" };
  assert.equal(generationPhase(message, false), "waiting");
  assert.equal(generationPhase({ ...message, thinking: "reason" }, false), "thinking");
  assert.equal(generationPhase({ ...message, content: "answer" }, false), "generating");
  assert.equal(generationPhase({ ...message, content: "answer", status: "complete" }, false), "waiting");
  assert.equal(generationPhase(message, true), "tool");
});
