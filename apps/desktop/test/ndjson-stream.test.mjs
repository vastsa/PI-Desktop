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
