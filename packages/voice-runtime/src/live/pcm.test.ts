import { describe, expect, it } from "vitest";
import { decodePcm16, encodePcm16, StreamingPcmResampler } from "./pcm.js";

function sine(rate: number, frequency: number, count: number): Float32Array {
  return Float32Array.from({ length: count }, (_, index) => Math.sin((2 * Math.PI * frequency * index) / rate));
}

function concat(parts: Float32Array[]): Float32Array {
  const result = new Float32Array(parts.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

describe("Live PCM helpers", () => {
  it("encodes signed PCM16 little-endian with finite clamping", () => {
    expect([...encodePcm16(Float32Array.of(-2, -0.5, 0, 0.5, 2, Number.NaN))]).toEqual([
      0, 128, 0, 192, 0, 0, 0, 64, 255, 127, 0, 0,
    ]);
    expect([...decodePcm16(Uint8Array.of(0, 128, 0, 64))]).toEqual([-1, 0.5]);
    expect(() => decodePcm16(Uint8Array.of(1))).toThrow(RangeError);
  });

  it("keeps resampling stable across arbitrary input chunk boundaries", () => {
    const input = sine(44100, 440, 44100);
    const whole = new StreamingPcmResampler(44100, 16000).push(input);
    const streaming = new StreamingPcmResampler(44100, 16000);
    const chunks: Float32Array[] = [];
    let offset = 0;
    const sizes = [1, 17, 251, 1024, 93, 311];
    let sizeIndex = 0;
    while (offset < input.length) {
      const end = Math.min(input.length, offset + sizes[sizeIndex++ % sizes.length]);
      chunks.push(streaming.push(input.subarray(offset, end)));
      offset = end;
    }
    const split = concat(chunks);
    expect(split.length).toBe(whole.length);
    let maxDifference = 0;
    for (let index = 0; index < whole.length; index += 1) {
      maxDifference = Math.max(maxDifference, Math.abs(whole[index] - split[index]));
    }
    expect(maxDifference).toBeLessThan(1e-5);
    expect(Math.abs(split.length - 16000)).toBeLessThan(16);
  });

  it("preserves passband tone and suppresses frequencies above the new Nyquist limit", () => {
    const passband = new StreamingPcmResampler(48000, 16000).push(sine(48000, 1000, 48000));
    const stopband = new StreamingPcmResampler(48000, 16000).push(sine(48000, 12000, 48000));
    const rms = (samples: Float32Array) => {
      const measured = samples.subarray(256, samples.length - 256);
      return Math.sqrt(measured.reduce((sum, sample) => sum + sample * sample, 0) / measured.length);
    };
    expect(rms(passband)).toBeGreaterThan(0.65);
    expect(rms(stopband)).toBeLessThan(0.03);
  });
});
