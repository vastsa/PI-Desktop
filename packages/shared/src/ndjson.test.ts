import { describe, expect, it } from "vitest";
import { readNdjsonLines } from "./ndjson.js";

type DataListener = (chunk: string) => void;
type SignalListener = () => void;

class FakeNdjsonInput {
  encoding: "utf8" | undefined;
  private data: DataListener[] = [];
  private end: SignalListener[] = [];
  private close: SignalListener[] = [];

  setEncoding(encoding: "utf8") {
    this.encoding = encoding;
    return this;
  }

  on(event: "data", listener: DataListener): this;
  on(event: "end" | "close", listener: SignalListener): this;
  on(event: string, listener: DataListener | SignalListener) {
    if (event === "data") this.data.push(listener as DataListener);
    else if (event === "end") this.end.push(listener as SignalListener);
    else if (event === "close") this.close.push(listener as SignalListener);
    return this;
  }

  off(event: "data", listener: DataListener): this;
  off(event: "end" | "close", listener: SignalListener): this;
  off(event: string, listener: DataListener | SignalListener) {
    if (event === "data") this.data = this.data.filter((item) => item !== listener);
    else if (event === "end") this.end = this.end.filter((item) => item !== listener);
    else if (event === "close") this.close = this.close.filter((item) => item !== listener);
    return this;
  }

  write(chunk: string) {
    for (const listener of this.data.slice()) listener(chunk);
  }

  finish(chunk?: string) {
    if (chunk) this.write(chunk);
    for (const listener of this.end.slice()) listener();
  }

  destroy() {
    for (const listener of this.close.slice()) listener();
  }

  listenerCount(event: "data" | "end" | "close") {
    return this[event].length;
  }

  listeners(event: "data" | "end" | "close") {
    return this[event].slice();
  }
}

const payload = { id: "rpc", result: { content: "A\u2028中文🙂\u2029B\r\nC" } };
const wire = new TextEncoder().encode(`${JSON.stringify(payload)}\n`);

describe("readNdjsonLines", () => {
  it("keeps U+2028/U+2029 inside JSON.stringify output as payload", () => {
    expect(JSON.stringify(payload)).toContain("\u2028");
    expect(JSON.stringify(payload)).toContain("\u2029");
    const input = new FakeNdjsonInput();
    const lines: unknown[] = [];
    readNdjsonLines(input, (line) => lines.push(JSON.parse(line)));
    expect(input.encoding).toBe("utf8");
    input.finish(new TextDecoder().decode(wire));
    expect(lines).toEqual([payload]);
  });

  it("preserves Unicode separators at every possible byte split", () => {
    for (let split = 0; split <= wire.length; split++) {
      const input = new FakeNdjsonInput();
      const lines: unknown[] = [];
      readNdjsonLines(input, (line) => lines.push(JSON.parse(line)));
      const decoder = new TextDecoder();
      const head = decoder.decode(wire.subarray(0, split), { stream: true });
      if (head) input.write(head);
      input.finish(decoder.decode(wire.subarray(split)));
      expect(lines, `split at byte ${split}`).toEqual([payload]);
    }
  });

  it("accepts consecutive LF/CRLF frames, blank lines, and an EOF tail", () => {
    const input = new FakeNdjsonInput();
    const lines: string[] = [];
    readNdjsonLines(input, (line) => lines.push(line));
    input.write('\n{"id":1}\r');
    expect(lines, "CR alone does not terminate a frame").toEqual([""]);
    input.write('\n{"id":2}\n{"id":');
    input.finish("3}");
    expect(lines).toEqual(["", '{"id":1}', '{"id":2}', '{"id":3}']);
    for (const event of ["data", "end", "close"] as const) {
      expect(input.listenerCount(event)).toBe(0);
    }
  });

  it("stops buffered frames on close and removes only owned listeners", () => {
    const input = new FakeNdjsonInput();
    const external: DataListener = () => {};
    input.on("data", external);
    const lines: string[] = [];
    const reader = readNdjsonLines(input, (line) => {
      lines.push(line);
      reader.close();
    });
    input.write("first\nsecond\npartial");
    reader.close();
    input.write("ignored\n");
    expect(lines).toEqual(["first"]);
    expect(input.listeners("data")).toEqual([external]);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("close")).toBe(0);
  });

  it("discards a partial frame and detaches when the stream is destroyed", () => {
    const input = new FakeNdjsonInput();
    const lines: string[] = [];
    readNdjsonLines(input, (line) => lines.push(line));
    input.write('{"unfinished":');
    input.destroy();
    expect(lines).toEqual([]);
    for (const event of ["data", "end", "close"] as const) {
      expect(input.listenerCount(event)).toBe(0);
    }
  });
});
