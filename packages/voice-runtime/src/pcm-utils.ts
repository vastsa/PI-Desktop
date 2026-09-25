/**
 * Coalesce Int16 recorder frames into one Float32 PCM buffer.
 * Kept free of native imports so pure-logic modules can share it.
 */
export function convertFrames(frames: readonly Int16Array[]): Float32Array {
  const sampleCount = frames.reduce((total, frame) => total + frame.length, 0);
  const pcm = new Float32Array(sampleCount);
  let offset = 0;

  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++) {
      pcm[offset + i] = (frame[i] ?? 0) / 32_768;
    }
    offset += frame.length;
  }

  return pcm;
}

/**
 * Compute the RMS (Root Mean Square) volume level from a Float32 PCM buffer.
 * Returns a value in 0–1 range.
 */
export function computeRms(pcm: Float32Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const sample = pcm[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / pcm.length);
}
