/**
 * Controllable stand-in for `@pi-desktop/voice-runtime`, loaded in place of
 * the real package by helpers/voice-service-stubs-hook.mjs. Exposes the
 * value exports audio-backend.ts imports plus the three classes
 * VoiceService lazily instantiates, with observability for the idle-unload
 * tests: `StubVoiceController.last` keeps the most recent instance so a test
 * can drive `stateChange` events, and `StubModelManager.unloadCalls` counts
 * unload invocations.
 */
import { EventEmitter } from "node:events";

export const CAPTURE_SAMPLE_RATE = 16000;
export const FRAME_LENGTH = 512;
export function convertFrames() {
  return new Float32Array(0);
}

export class StubModelManager {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.unloadCalls = 0;
  }
  unload() {
    this.unloadCalls += 1;
  }
  getAllStates() {
    return [];
  }
  getState() {
    return undefined;
  }
  getLoadedModelId() {
    return null;
  }
  async *download() {
    yield 1;
  }
  async deleteModel() {}
}

export class StubTranscriptionEngine {
  constructor(modelManager) {
    this.modelManager = modelManager;
  }
  async transcribe() {
    return "";
  }
  createStream() {
    return null;
  }
  async shutdown() {}
}

export class StubVoiceController extends EventEmitter {
  static last = null;

  constructor(engine, captureFactory, getSettings) {
    super();
    this.engine = engine;
    this.modelManager = engine.modelManager;
    this.state = { phase: "idle", durationSeconds: 0, volumeLevel: 0 };
    StubVoiceController.last = this;
  }

  async start() {
    this.setPhase("listening");
  }

  async stop() {
    this.setPhase("done");
    return { text: "", speechSeconds: 0, transcribeSeconds: 0, language: "en" };
  }

  cancel() {
    this.setPhase("idle");
  }

  dispose() {
    this.setPhase("idle");
  }

  setPhase(phase) {
    this.state = { ...this.state, phase };
    this.emit("stateChange", this.state);
  }
}

// VoiceService destructures the canonical names out of its dynamic import.
export {
  StubModelManager as ModelManager,
  StubTranscriptionEngine as TranscriptionEngine,
  StubVoiceController as VoiceController,
};
