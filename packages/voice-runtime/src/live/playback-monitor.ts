export const LIVE_PLAYBACK_SIGNAL_RMS_THRESHOLD = 0.004;

/** Detect audible-level samples without forwarding or retaining audio data. */
export function isPlaybackSignalActive(samples: Float32Array): boolean {
  if (samples.length === 0) return false;
  let energy = 0;
  for (const sample of samples) {
    if (Number.isFinite(sample)) energy += sample * sample;
  }
  return Math.sqrt(energy / samples.length) >= LIVE_PLAYBACK_SIGNAL_RMS_THRESHOLD;
}
