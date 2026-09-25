import { STREAM_CHUNK_SAMPLES } from "./audio-constants.js";
import { convertFrames } from "./pcm-utils.js";

/**
 * Coalesces recorder frames into Float32 PCM chunks without timers.
 * Used for streaming transcription: frames are accumulated and emitted
 * once the target sample count is reached.
 */
export class PcmChunker {
  private frames: Int16Array[] = [];
  private sampleCount = 0;

  constructor(
    private readonly onChunk: (chunk: Float32Array) => void,
    private readonly targetSamples = STREAM_CHUNK_SAMPLES,
  ) {
    if (!Number.isInteger(targetSamples) || targetSamples <= 0) {
      throw new Error("PCM chunk size must be a positive integer");
    }
  }

  push(frame: Int16Array): void {
    if (frame.length === 0) return;
    this.frames.push(frame);
    this.sampleCount += frame.length;
    if (this.sampleCount >= this.targetSamples) this.emit();
  }

  flush(): void {
    if (this.sampleCount > 0) this.emit();
  }

  discard(): void {
    this.frames = [];
    this.sampleCount = 0;
  }

  private emit(): void {
    const pcm = convertFrames(this.frames);
    this.frames = [];
    this.sampleCount = 0;
    this.onChunk(pcm);
  }
}
