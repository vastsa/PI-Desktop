/** Bounded PCM helpers shared by the Live adapters and the renderer worklet. */

const FILTER_TAPS = 49;
const FILTER_RADIUS = (FILTER_TAPS - 1) / 2;
const PHASES = 128;

export function encodePcm16(samples: Float32Array): Uint8Array {
  const output = new Uint8Array(samples.length * 2);
  const view = new DataView(output.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Number.isFinite(samples[index])
      ? Math.min(1, Math.max(-1, samples[index]))
      : 0;
    view.setInt16(index * 2, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true);
  }
  return output;
}

export function decodePcm16(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 2 !== 0) throw new RangeError("PCM16 data must contain whole samples");
  const output = new Float32Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = view.getInt16(index * 2, true) / 32768;
  }
  return output;
}

function sinc(value: number): number {
  if (Math.abs(value) < 1e-8) return 1;
  const angle = Math.PI * value;
  return Math.sin(angle) / angle;
}

function coefficients(sourceRate: number, targetRate: number): Float64Array[] {
  const cutoff = 0.45 * Math.min(1, targetRate / sourceRate);
  return Array.from({ length: PHASES }, (_, phaseIndex) => {
    const phase = phaseIndex / PHASES;
    const taps = new Float64Array(FILTER_TAPS);
    let total = 0;
    for (let tap = 0; tap < FILTER_TAPS; tap += 1) {
      const distance = tap - FILTER_RADIUS - phase;
      const normalized = distance / (FILTER_RADIUS + 1);
      const window = 0.42 + 0.5 * Math.cos(Math.PI * normalized) + 0.08 * Math.cos(2 * Math.PI * normalized);
      const weight = 2 * cutoff * sinc(2 * cutoff * distance) * window;
      taps[tap] = weight;
      total += weight;
    }
    if (total !== 0) for (let tap = 0; tap < taps.length; tap += 1) taps[tap] /= total;
    return taps;
  });
}

/** Stateful windowed-sinc resampler. Chunk boundaries do not reset its phase. */
export class StreamingPcmResampler {
  private input = new Float32Array(0);
  private inputStart = 0;
  private totalInput = 0;
  private nextOutput = 0;
  private readonly step: number;
  private readonly phases: Float64Array[];

  constructor(
    readonly sourceRate: number,
    readonly targetRate: number,
  ) {
    if (!Number.isFinite(sourceRate) || !Number.isFinite(targetRate) || sourceRate < 8000 || targetRate < 8000) {
      throw new RangeError("Audio sample rates must be finite and at least 8 kHz");
    }
    this.step = sourceRate / targetRate;
    this.phases = coefficients(sourceRate, targetRate);
  }

  push(chunk: Float32Array): Float32Array {
    if (this.sourceRate === this.targetRate) {
      return Float32Array.from(chunk, (sample) => Number.isFinite(sample) ? sample : 0);
    }
    this.append(chunk);
    const output: number[] = [];
    while (true) {
      const position = this.nextOutput * this.step;
      const center = Math.floor(position);
      if (center + FILTER_RADIUS >= this.totalInput) break;
      const phaseIndex = Math.min(PHASES - 1, Math.floor((position - center) * PHASES));
      const taps = this.phases[phaseIndex];
      let value = 0;
      for (let tap = 0; tap < FILTER_TAPS; tap += 1) {
        const sourceIndex = center + tap - FILTER_RADIUS;
        const localIndex = sourceIndex - this.inputStart;
        if (sourceIndex >= 0 && localIndex >= 0 && localIndex < this.input.length) {
          value += this.input[localIndex] * taps[tap];
        }
      }
      output.push(Number.isFinite(value) ? value : 0);
      this.nextOutput += 1;
    }
    this.discardOldSamples();
    return Float32Array.from(output);
  }

  reset(): void {
    this.input = new Float32Array(0);
    this.inputStart = 0;
    this.totalInput = 0;
    this.nextOutput = 0;
  }

  private append(chunk: Float32Array): void {
    if (chunk.length === 0) return;
    const next = new Float32Array(this.input.length + chunk.length);
    next.set(this.input);
    for (let index = 0; index < chunk.length; index += 1) {
      next[this.input.length + index] = Number.isFinite(chunk[index]) ? chunk[index] : 0;
    }
    this.input = next;
    this.totalInput += chunk.length;
  }

  private discardOldSamples(): void {
    const nextCenter = Math.floor(this.nextOutput * this.step);
    const discardThrough = Math.max(0, nextCenter - FILTER_RADIUS);
    const discardCount = Math.min(this.input.length, discardThrough - this.inputStart);
    if (discardCount <= 0) return;
    this.input = this.input.slice(discardCount);
    this.inputStart += discardCount;
  }
}
