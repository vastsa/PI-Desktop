import { describe, it, expect, vi, beforeEach } from "vitest";
import { VoiceController } from "../src/voice-controller.js";
import type {
  AudioCapture,
  AudioCaptureFactory,
  VoiceSettings,
} from "../src/types.js";
import type { TranscriptionEngine } from "../src/transcription-engine.js";

// Mock TranscriptionEngine
function createMockEngine() {
  return {
    transcribe: vi.fn().mockResolvedValue("hello world"),
    createStream: vi.fn().mockReturnValue(null),
    shutdown: vi.fn(),
    modelManager: {
      ensureLoaded: vi.fn().mockResolvedValue(undefined),
      getLoadedModelId: vi.fn().mockReturnValue("whisper-large-v3-turbo"),
      getLoadedModel: vi.fn().mockReturnValue({}),
      unload: vi.fn(),
    },
  };
}

// Mock AudioCaptureFactory
function createMockCaptureFactory(): AudioCaptureFactory {
  let frameCallback: ((frame: Int16Array) => void) | null = null;

  const capture: AudioCapture = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(new Float32Array([])),
    cancel: vi.fn(),
    onFrame: vi.fn((cb) => { frameCallback = cb; }),
    get isActive() { return true; },
  };

  return {
    getDevices: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockReturnValue(capture),
    checkPermission: vi.fn().mockResolvedValue("granted"),
    requestPermission: vi.fn().mockResolvedValue(true),
  };
}

function defaultSettings(): VoiceSettings {
  return {
    enabled: true,
    deviceId: null,
    languages: ["zh", "en"],
    chineseVariant: "simplified",
    modelId: "whisper-large-v3-turbo",
  };
}

describe("VoiceController", () => {
  let engine: ReturnType<typeof createMockEngine>;
  let factory: AudioCaptureFactory;
  let settings: VoiceSettings;
  let controller: VoiceController;

  beforeEach(() => {
    engine = createMockEngine();
    factory = createMockCaptureFactory();
    settings = defaultSettings();
    controller = new VoiceController(
      engine as unknown as TranscriptionEngine,
      factory,
      () => settings,
    );
  });

  it("starts in idle state", () => {
    expect(controller.state.phase).toBe("idle");
  });

  it("prepare transitions to ready", async () => {
    await controller.prepare();
    expect(controller.state.phase).toBe("ready");
  });

  it("prepare throws if no model selected", async () => {
    settings.modelId = "";
    await expect(controller.prepare()).rejects.toThrow("No model selected");
  });

  it("start transitions through states", async () => {
    const phases: string[] = [];
    controller.on("stateChange", (s) => phases.push(s.phase));

    await controller.start();
    expect(phases).toContain("preparing");
    expect(phases).toContain("starting");
    expect(controller.state.phase).toBe("listening");
  });

  it("cancel returns to idle", async () => {
    await controller.start();
    controller.cancel();
    expect(controller.state.phase).toBe("idle");
  });

  it("cancelling while preparing does not enter ready or start capture", async () => {
    let resolveLoaded!: () => void;
    engine.modelManager.ensureLoaded.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLoaded = resolve;
      }),
    );

    const starting = controller.start();
    await Promise.resolve();
    controller.cancel();
    resolveLoaded();

    await expect(starting).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.state.phase).toBe("idle");
    expect(factory.create).not.toHaveBeenCalled();
  });

  it("cancelling during transcription suppresses the late result", async () => {
    let resolveTranscript!: (text: string) => void;
    engine.transcribe.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveTranscript = resolve;
      }),
    );
    const phases: string[] = [];
    controller.on("stateChange", (state) => phases.push(state.phase));

    await controller.start();
    const stopping = controller.stop();
    await Promise.resolve();
    controller.cancel();
    resolveTranscript("late result");

    await expect(stopping).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.state.phase).toBe("idle");
    expect(phases).not.toContain("done");
  });

  it("cannot start from non-idle/ready phase", async () => {
    await controller.start();
    await expect(controller.start()).rejects.toThrow("Cannot start from phase");
  });

  it("dispose prevents further use", async () => {
    controller.dispose();
    await expect(controller.start()).rejects.toThrow("disposed");
  });

  it("emits stateChange events", async () => {
    const listener = vi.fn();
    controller.on("stateChange", listener);
    await controller.start();
    expect(listener).toHaveBeenCalled();
  });
});
