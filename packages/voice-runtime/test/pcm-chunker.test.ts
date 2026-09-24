import { describe, it, expect, vi } from "vitest";
import { PcmChunker } from "../src/pcm-chunker.js";

describe("PcmChunker", () => {
  it("throws on invalid chunk size", () => {
    expect(() => new PcmChunker(() => {}, 0)).toThrow();
    expect(() => new PcmChunker(() => {}, -1)).toThrow();
    expect(() => new PcmChunker(() => {}, 1.5)).toThrow();
  });

  it("does not emit until target samples reached", () => {
    const onChunk = vi.fn();
    const chunker = new PcmChunker(onChunk, 10);

    chunker.push(new Int16Array([1, 2, 3]));
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("emits when target samples are reached", () => {
    const onChunk = vi.fn();
    const chunker = new PcmChunker(onChunk, 4);

    chunker.push(new Int16Array([1, 2]));
    chunker.push(new Int16Array([3, 4]));

    expect(onChunk).toHaveBeenCalledTimes(1);
    const chunk = onChunk.mock.calls[0][0];
    expect(chunk).toBeInstanceOf(Float32Array);
    expect(chunk.length).toBe(4);
  });

  it("flush emits remaining samples", () => {
    const onChunk = vi.fn();
    const chunker = new PcmChunker(onChunk, 100);

    chunker.push(new Int16Array([10, 20]));
    expect(onChunk).not.toHaveBeenCalled();

    chunker.flush();
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk.mock.calls[0][0].length).toBe(2);
  });

  it("flush does nothing when empty", () => {
    const onChunk = vi.fn();
    const chunker = new PcmChunker(onChunk, 10);

    chunker.flush();
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("discard clears accumulated frames", () => {
    const onChunk = vi.fn();
    const chunker = new PcmChunker(onChunk, 10);

    chunker.push(new Int16Array([1, 2, 3]));
    chunker.discard();
    chunker.flush();

    expect(onChunk).not.toHaveBeenCalled();
  });

  it("ignores empty frames", () => {
    const onChunk = vi.fn();
    const chunker = new PcmChunker(onChunk, 2);

    chunker.push(new Int16Array([]));
    chunker.push(new Int16Array([1, 2]));

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk.mock.calls[0][0].length).toBe(2);
  });
});
