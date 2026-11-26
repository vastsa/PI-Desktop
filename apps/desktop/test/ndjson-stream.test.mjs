import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readNdjsonLines } from "../../../packages/shared/src/ndjson.ts";

const payload = { id: "rpc", result: { content: "A\u2028中文🙂\u2029B\r\nC" } };
const wire = Buffer.from(`${JSON.stringify(payload)}\n`);

test("Node setEncoding preserves Unicode separators at every byte split", async () => {
  for (let split = 0; split <= wire.length; split++) {
    const input = new PassThrough();
    const lines = [];
    readNdjsonLines(input, (line) => lines.push(JSON.parse(line)));
    const ended = once(input, "end");
    input.write(wire.subarray(0, split));
    input.end(wire.subarray(split));
    await ended;
    assert.deepEqual(lines, [payload], `split at byte ${split}`);
  }
});

test("oversized lines are discarded through LF and later frames remain readable", async () => {
  const input = new PassThrough();
  const lines = [];
  const errors = [];
  readNdjsonLines(input, (line) => lines.push(line), {
    maxLineBytes: 8,
    onFrameError: (error) => errors.push(error),
  });
  const ended = once(input, "end");
  input.write("12345678");
  assert.equal(errors.length, 0);
  input.write("9");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].prefix, "123456789");
  assert.equal(errors[0].observedBytes, 9);
  assert.equal(errors[0].limitBytes, 8);
  assert.ok(errors[0].error instanceof Error);
  input.end("still discarded\nOK\r\n12345678");
  await ended;
  assert.equal(errors.length, 1);
  assert.deepEqual(lines, ["OK", "12345678"]);
});

test("the line limit counts UTF-8 bytes and includes CRLF", async () => {
  const valid = Buffer.from("中🙂\r\n");
  const over = Buffer.from("中🙂x\r\n");
  for (let split = 0; split <= over.length; split++) {
    const input = new PassThrough();
    const events = [];
    readNdjsonLines(input, (line) => events.push(line), {
      maxLineBytes: valid.length,
      onFrameError: ({ observedBytes }) => events.push(observedBytes),
    });
    const ended = once(input, "end");
    input.write(over.subarray(0, split));
    input.end(Buffer.concat([over.subarray(split), valid]));
    await ended;
    assert.deepEqual(events, [over.length, "中🙂"], `split at byte ${split}`);
  }
});

test("the discarded EOF tail is reported once and listeners are removed", async () => {
  const input = new PassThrough();
  const errors = [];
  readNdjsonLines(input, () => assert.fail("emitted a discarded frame"), {
    maxLineBytes: 4,
    onFrameError: (failure) => errors.push(failure),
  });
  const ended = once(input, "end");
  input.write("12345");
  input.end("more without LF");
  await ended;
  assert.equal(errors.length, 1);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("close"), 0);
});

test("the oversized frame preview is bounded across tiny fragments", async () => {
  const input = new PassThrough();
  const lines = [];
  const errors = [];
  readNdjsonLines(input, (line) => lines.push(line), {
    maxLineBytes: 8193,
    onFrameError: (failure) => errors.push(failure),
  });
  const ended = once(input, "end");
  for (let i = 0; i < 8192; i++) input.write("x");
  input.write("\n");
  for (let i = 0; i < 8192; i++) input.write("y");
  input.end("xx\nnext\n");
  await ended;
  assert.deepEqual(lines, ["x".repeat(8192), "next"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].prefix, "y".repeat(2048));
});

test("a consumer exception propagates after resetting the frame", () => {
  const input = new PassThrough();
  const lines = [];
  const failure = new RangeError("consumer error");
  const reader = readNdjsonLines(input, (line) => {
    if (line === "first") throw failure;
    lines.push(line);
  }, {
    onFrameError: () => assert.fail("treated a consumer error as a frame error"),
  });
  try {
    input.emit("data", "fir");
    assert.throws(() => input.emit("data", "st\n"), (error) => error === failure);
    input.emit("data", "next\n");
    assert.deepEqual(lines, ["next"]);
  } finally {
    reader.close();
    input.destroy();
  }
});

test("an assembly RangeError leaves subsequent frames readable", (t) => {
  const input = new PassThrough();
  const lines = [];
  const errors = [];
  const reader = readNdjsonLines(input, (line) => lines.push(line), {
    onFrameError: (failure) => errors.push(failure),
  });
  const failure = new RangeError("synthetic assembly failure");
  const originalJoin = Array.prototype.join;
  let injected = false;
  Array.prototype.join = function (separator) {
    if (!injected && this.length === 2 && this[0] === "bro" && this[1] === "ken") {
      injected = true;
      throw failure;
    }
    return Reflect.apply(originalJoin, this, [separator]);
  };
  try {
    input.emit("data", "bro");
    input.emit("data", "ken\nnext\n");
  } finally {
    Array.prototype.join = originalJoin;
    reader.close();
    input.destroy();
  }
  assert.deepEqual(lines, ["next"]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].kind, "assembly");
  assert.equal(errors[0].prefix, "broken");
  assert.equal(errors[0].error, failure);
});

test("uncapped existing readers retain records above the Host frame budget", async () => {
  const input = new PassThrough();
  const sizes = [];
  readNdjsonLines(input, (line) => sizes.push(line.length));
  const ended = once(input, "end");
  const block = "x".repeat(1024 * 1024);
  for (let i = 0; i < 65; i++) input.write(block);
  input.end("\nnext\n");
  await ended;
  assert.deepEqual(sizes, [65 * block.length, 4]);
});

test("an explicit cap without an error handler fails observably", () => {
  const input = new PassThrough();
  const reader = readNdjsonLines(input, () => assert.fail("oversized frame delivered"), { maxLineBytes: 8 });
  try { assert.throws(() => input.emit("data", "123456789"), /byte limit/); }
  finally { reader.close(); input.destroy(); }
});
