import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  appendTokenSample,
  calculateWindowedTokenRate,
  resolveStreamingOutputTokens,
  shouldResetTokenRateWindow,
} from "../src/lib/streaming-token-rate.ts";

test("windowed rate ignores growth outside the sliding window", () => {
  const samples = [
    { atMs: 0, tokens: 0 },
    { atMs: 1_000, tokens: 100 },
    { atMs: 3_000, tokens: 120 },
  ];
  // Window [1000, 3000]: start tokens at t=1000 → 100, end → 120 ⇒ 20 / 2s = 10.
  assert.equal(
    calculateWindowedTokenRate(samples, 3_000, {
      windowMs: 2_000,
      minDurationMs: 200,
    }),
    10,
  );
});

test("zero duration returns undefined", () => {
  assert.equal(
    calculateWindowedTokenRate([{ atMs: 1_000, tokens: 50 }], 1_000, {
      minDurationMs: 200,
    }),
    undefined,
  );
  assert.equal(
    calculateWindowedTokenRate(
      [
        { atMs: 1_000, tokens: 0 },
        { atMs: 1_000, tokens: 80 },
      ],
      1_000,
      { minDurationMs: 0 },
    ),
    undefined,
  );
});

test("burst concentrates rate inside a short recent window", () => {
  const samples = [
    { atMs: 0, tokens: 0 },
    { atMs: 1_800, tokens: 0 },
    { atMs: 2_000, tokens: 400 },
  ];
  // Window [0, 2000] but growth is only in the last 200ms: 400 / 2s = 200
  // when measuring against now with a 2s window that includes the quiet prefix.
  assert.equal(
    calculateWindowedTokenRate(samples, 2_000, {
      windowMs: 2_000,
      minDurationMs: 100,
    }),
    200,
  );
  // Narrower window that starts at the quiet sample: 400 / 0.2s = 2000.
  assert.equal(
    calculateWindowedTokenRate(samples, 2_000, {
      windowMs: 200,
      minDurationMs: 100,
    }),
    2_000,
  );
});

test("stall reports zero after the window advances without growth", () => {
  const samples = [
    { atMs: 0, tokens: 0 },
    { atMs: 500, tokens: 100 },
  ];
  assert.equal(
    calculateWindowedTokenRate(samples, 3_000, {
      windowMs: 2_000,
      minDurationMs: 200,
    }),
    0,
  );
});

test("never-produced output stays undefined instead of false 0 tok/s", () => {
  const samples = [
    { atMs: 0, tokens: 0 },
    { atMs: 500, tokens: 0 },
    { atMs: 2_000, tokens: 0 },
  ];
  assert.equal(
    calculateWindowedTokenRate(samples, 3_000, {
      windowMs: 2_000,
      minDurationMs: 200,
    }),
    undefined,
  );
});

test("below min duration stays undefined even with tokens", () => {
  assert.equal(
    calculateWindowedTokenRate(
      [
        { atMs: 0, tokens: 0 },
        { atMs: 50, tokens: 40 },
      ],
      50,
      { windowMs: 2_000, minDurationMs: 200 },
    ),
    undefined,
  );
});

test("appendTokenSample keeps tokens monotonic and drops stale entries", () => {
  const first = appendTokenSample([], { atMs: 1_000, tokens: 10 }, 1_000, 1_000);
  assert.deepEqual(first, [{ atMs: 1_000, tokens: 10 }]);
  const second = appendTokenSample(
    first,
    { atMs: 1_500, tokens: 8 },
    1_500,
    1_000,
  );
  assert.deepEqual(second, [
    { atMs: 1_000, tokens: 10 },
    { atMs: 1_500, tokens: 10 },
  ]);
  const trimmed = appendTokenSample(
    second,
    { atMs: 3_000, tokens: 20 },
    3_000,
    1_000,
  );
  assert.deepEqual(trimmed, [{ atMs: 3_000, tokens: 20 }]);
});

test("estimate→provider flip detects lower provider count for window reset", () => {
  assert.equal(
    shouldResetTokenRateWindow({
      wasEstimated: true,
      nowEstimated: false,
      previousTokens: 120,
      nextTokens: 40,
    }),
    true,
  );
  assert.equal(
    shouldResetTokenRateWindow({
      wasEstimated: true,
      nowEstimated: false,
      previousTokens: 40,
      nextTokens: 80,
    }),
    false,
  );
  assert.equal(
    shouldResetTokenRateWindow({
      wasEstimated: false,
      nowEstimated: false,
      previousTokens: 120,
      nextTokens: 40,
    }),
    false,
  );

  // Without reset, monotonic clamp freezes growth and the window drains to 0.
  const estimated = [
    { atMs: 0, tokens: 0 },
    { atMs: 500, tokens: 100 },
    { atMs: 1_000, tokens: 120 },
  ];
  const clamped = appendTokenSample(
    estimated,
    { atMs: 1_200, tokens: 40 },
    1_200,
  );
  assert.equal(clamped[clamped.length - 1].tokens, 120);
  assert.equal(
    calculateWindowedTokenRate(clamped, 3_500, {
      windowMs: 2_000,
      minDurationMs: 200,
    }),
    0,
  );

  // Resetting the window on handoff keeps the chip hidden until fresh signal.
  assert.equal(
    calculateWindowedTokenRate([{ atMs: 1_200, tokens: 40 }], 1_250, {
      windowMs: 2_000,
      minDurationMs: 200,
    }),
    undefined,
  );
  assert.equal(
    calculateWindowedTokenRate(
      [
        { atMs: 1_200, tokens: 40 },
        { atMs: 1_700, tokens: 90 },
      ],
      1_700,
      { windowMs: 2_000, minDurationMs: 200 },
    ),
    100,
  );
});

test("resolveStreamingOutputTokens prefers provider usage over text estimate", () => {
  assert.deepEqual(
    resolveStreamingOutputTokens({
      outputTokens: 42,
      content: "a long answer that would estimate differently",
    }),
    { tokens: 42, estimated: false },
  );
  assert.deepEqual(
    resolveStreamingOutputTokens({ content: "abcd" }),
    { tokens: 1, estimated: true },
  );
  assert.deepEqual(resolveStreamingOutputTokens({}), {
    tokens: 0,
    estimated: true,
  });
});

test("useLiveTokenRate interval depends only on active/tickMs via input refs", async () => {
  const source = await readFile(
    new URL("../src/features/chat/transcript/hooks/useLiveTokenRate.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /inputRef\.current = input/);
  assert.match(source, /shouldResetTokenRateWindow\(/);
  assert.match(
    source,
    /}, \[input\.active, input\.tickMs\]\);/,
  );
  assert.doesNotMatch(
    source,
    /}, \[\s*input\.active,\s*input\.content,\s*input\.thinking,\s*input\.outputTokens,\s*input\.tickMs,\s*\]\)/,
  );
});
