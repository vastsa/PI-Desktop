import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateSessionTimingBreakdown,
  calculateSessionTiming,
  loadEarlierModelResponseDuration,
  loadEarlierSessionTiming,
  sumModelResponseDuration,
} from "../src/lib/session-timing.ts";

test("session response duration sums top-level model responses only", () => {
  assert.equal(
    sumModelResponseDuration([
      { role: "assistant", responseDurationMs: 1_250 },
      { role: "assistant", responseDurationMs: 2_000, parentToolCallId: "task-1" },
      { role: "assistant", responseDurationMs: 3_000, nestedParentToolCallId: "call-1" },
      { role: "tool", responseDurationMs: 4_000 },
      { role: "assistant", responseDurationMs: Number.NaN },
      { role: "assistant", responseDurationMs: -50 },
    ]),
    1_250,
  );
});

test("session timing uses elapsed wall time and includes the live model request", () => {
  const messages = [
    { role: "assistant", responseDurationMs: 2_500 },
    { role: "assistant", responseDurationMs: 1_500 },
  ];
  const idle = calculateSessionTiming({
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:10.000Z",
    isRunning: false,
    messages,
    now: Date.parse("2026-10-01T00:00:12.000Z"),
  });
  assert.deepEqual(idle, {
    elapsedMs: 10_000,
    modelResponseMs: 4_000,
    modelResponsePercent: 40,
  });

  const running = calculateSessionTiming({
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:10.000Z",
    isRunning: true,
    messages,
    now: Date.parse("2026-10-01T00:00:12.000Z"),
    activeModelRequestStartedAt: Date.parse("2026-10-01T00:00:09.000Z"),
  });
  assert.deepEqual(running, {
    elapsedMs: 12_000,
    modelResponseMs: 7_000,
    modelResponsePercent: 58,
  });

  const streaming = calculateSessionTiming({
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:10.000Z",
    isRunning: true,
    messages: [
      ...messages,
      {
        role: "assistant",
        status: "streaming",
        createdAt: "2026-10-01T00:00:10.000Z",
      },
    ],
    now: Date.parse("2026-10-01T00:00:12.000Z"),
  });
  assert.equal(streaming?.modelResponseMs, 6_000);
  assert.equal(streaming?.modelResponsePercent, 50);
});

test("earlier response durations load through bounded transcript pages", async () => {
  const pages = new Map([
    [2_500, {
      messages: [{ role: "assistant", responseDurationMs: 1_000 }],
      messageStart: 1_500,
      hasMoreBefore: true,
    }],
    [1_500, {
      messages: [{ role: "assistant", responseDurationMs: 2_000 }],
      messageStart: 500,
      hasMoreBefore: true,
    }],
    [500, {
      messages: [{ role: "assistant", responseDurationMs: 3_000 }],
      messageStart: 0,
      hasMoreBefore: false,
    }],
  ]);
  const reads = [];

  const durationMs = await loadEarlierModelResponseDuration(2_500, async (options) => {
    reads.push(options);
    return pages.get(options.messageBefore) ?? null;
  });

  assert.equal(durationMs, 6_000);
  assert.deepEqual(reads.map((read) => read.messageBefore), [2_500, 1_500, 500]);
  assert.ok(reads.every((read) => read.messageLimit === 1_000));
  assert.ok(reads.every((read) => read.contentLimit === 256));
});

test("earlier timing pages fail visibly when their cursor does not advance", async () => {
  await assert.rejects(
    loadEarlierModelResponseDuration(250, async () => ({
      messages: [],
      messageStart: 250,
      hasMoreBefore: true,
    })),
    /did not advance/,
  );
});

test("session timing separates provider wait, streamed response, and overlapping tools", () => {
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  const at = (offsetMs) => new Date(start + offsetMs).toISOString();

  assert.deepEqual(
    calculateSessionTimingBreakdown({
      elapsedMs: 20_000,
      now: start + 20_000,
      messages: [
        {
          role: "assistant",
          createdAt: at(0),
          providerWaitMs: 1_000,
          modelStreamDurationMs: 2_000,
        },
        {
          role: "assistant",
          createdAt: at(0),
          providerWaitMs: 500,
          modelStreamDurationMs: 1_000,
          parentToolCallId: "delegate-1",
        },
        {
          role: "tool",
          createdAt: at(5_000),
          toolCompletedAt: at(9_000),
          toolDurationMs: 4_000,
        },
        {
          role: "tool",
          createdAt: at(7_000),
          toolCompletedAt: at(11_000),
          toolDurationMs: 4_000,
        },
        {
          role: "tool",
          createdAt: at(5_000),
          toolCompletedAt: at(19_000),
          toolDurationMs: 14_000,
          nestedParentToolCallId: "delegate-1",
        },
      ],
    }),
    {
      networkRequestMs: 1_000,
      networkRequestPercent: 5,
      modelResponseMs: 2_000,
      modelResponsePercent: 10,
      toolCallMs: 6_000,
      toolCallPercent: 30,
    },
  );
});

test("session timing uses legacy model durations and live request/stream timers", () => {
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  const breakdown = calculateSessionTimingBreakdown({
    elapsedMs: 10_000,
    now: start + 10_000,
    activeNetworkRequestStartedAt: start + 8_000,
    messages: [
      {
        role: "assistant",
        createdAt: new Date(start + 7_000).toISOString(),
        status: "streaming",
        providerWaitMs: 250,
        modelStreamDurationMs: 500,
      },
      {
        role: "assistant",
        createdAt: new Date(start).toISOString(),
        responseDurationMs: 1_000,
      },
    ],
  });

  assert.deepEqual(breakdown, {
    networkRequestMs: 2_250,
    networkRequestPercent: 23,
    modelResponseMs: 4_500,
    modelResponsePercent: 45,
    toolCallMs: 0,
    toolCallPercent: 0,
  });
});

test("earlier timing pages include request, response, and tool metadata", async () => {
  const pages = new Map([
    [2_000, {
      messages: [{
        role: "assistant",
        createdAt: "2026-10-01T00:00:00.000Z",
        providerWaitMs: 700,
        modelStreamDurationMs: 1_200,
      }],
      messageStart: 1_000,
      hasMoreBefore: true,
    }],
    [1_000, {
      messages: [{
        role: "tool",
        createdAt: "2026-10-01T00:00:01.000Z",
        toolCompletedAt: "2026-10-01T00:00:03.000Z",
        toolDurationMs: 2_000,
      }],
      messageStart: 0,
      hasMoreBefore: false,
    }],
  ]);
  const reads = [];

  const totals = await loadEarlierSessionTiming(2_000, async (options) => {
    reads.push(options);
    return pages.get(options.messageBefore) ?? null;
  });

  assert.equal(totals.providerWaitMs, 700);
  assert.equal(totals.modelResponseMs, 1_200);
  assert.equal(totals.toolMessageCount, 1);
  assert.equal(totals.toolTimingCount, 1);
  assert.deepEqual(totals.toolIntervals, [{
    start: Date.parse("2026-10-01T00:00:01.000Z"),
    end: Date.parse("2026-10-01T00:00:03.000Z"),
  }]);
  assert.deepEqual(reads.map((read) => read.messageBefore), [2_000, 1_000]);
});
