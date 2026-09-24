/** Capture sample rate for all voice processing (16 kHz mono). */
export const CAPTURE_SAMPLE_RATE = 16_000;

/** PvRecorder frame length in samples. */
export const FRAME_LENGTH = 512;

/** Default streaming chunk size: 0.5 seconds of audio at 16 kHz. */
export const STREAM_CHUNK_SAMPLES = CAPTURE_SAMPLE_RATE / 2;
