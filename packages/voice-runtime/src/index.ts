// Types
export type {
  VoicePhase,
  VoiceState,
  VoiceResult,
  VoiceSettings,
  ChineseVariant,
  ModelInfo,
  ModelStatus,
  ModelState,
  AudioInputDevice,
  AudioCapture,
  AudioCaptureFactory,
  TranscribeOptions,
  TranscriptionStream,
} from "./types.js";
export { DEFAULT_VOICE_SETTINGS } from "./types.js";

// Constants
export { CAPTURE_SAMPLE_RATE, FRAME_LENGTH, STREAM_CHUNK_SAMPLES } from "./audio-constants.js";

// Core classes
export { VoiceController } from "./voice-controller.js";
export { TranscriptionEngine } from "./transcription-engine.js";
export { ModelManager } from "./model-manager.js";

// Utilities
export { PcmChunker } from "./pcm-chunker.js";
export { convertFrames, computeRms } from "./pcm-utils.js";
export { isChineseLanguage, convertChineseOutput } from "./chinese.js";
export { SUPPORTED_LANGUAGES, languageLabel } from "./languages.js";
export { getCatalog, findModel, getRecommendedModel } from "./model-catalog.js";
