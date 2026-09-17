import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readNdjsonLines } from "../../../packages/shared/src/ndjson.ts";

const payload = { id: "rpc", result: { content: "A\u2028中文🙂\u2029B\r\nC" } };
const wire = Buffer.from(JSON.stringify(payload) + "\n");

test("NDJSON preserves Unicode separators at every possible byte split", async () => {
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

test("NDJSON accepts consecutive LF/CRLF frames, blank lines, and EOF tail", async () => {
  const input = new PassThrough();
  const lines = [];
  readNdjsonLines(input, (line) => lines.push(line));
  const ended = once(input, "end");
  input.write('\n{"id":1}\r');
  assert.deepEqual(lines, [""], "CR alone does not terminate a frame");
  input.write('\n{"id":2}\n{"id":');
  input.end("3}");
  await ended;
  assert.deepEqual(lines, ["", '{"id":1}', '{"id":2}', '{"id":3}']);
  for (const event of ["data", "end", "close"]) assert.equal(input.listenerCount(event), 0);
});

test("closing inside a callback stops buffered frames and removes only owned listeners", () => {
  const input = new PassThrough();
  const external = () => {};
  input.on("data", external);
  const lines = [];
  const reader = readNdjsonLines(input, (line) => { lines.push(line); reader.close(); });
  input.write("first\nsecond\npartial");
  reader.close();
  input.write("ignored\n");
  assert.deepEqual(lines, ["first"]);
  assert.deepEqual(input.listeners("data"), [external]);
  assert.equal(input.listenerCount("end"), 0);
  assert.equal(input.listenerCount("close"), 0);
  input.destroy();
});

test("stream destruction discards a partial frame and detaches the reader", async () => {
  const input = new PassThrough();
  const lines = [];
  readNdjsonLines(input, (line) => lines.push(line));
  input.write('{"unfinished":');
  const closed = once(input, "close");
  input.destroy();
  await closed;
  assert.deepEqual(lines, []);
  for (const event of ["data", "end", "close"]) assert.equal(input.listenerCount(event), 0);
});
