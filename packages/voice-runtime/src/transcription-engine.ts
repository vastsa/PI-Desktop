import { isChineseLanguage, convertChineseOutput } from "./chinese.js";
import type { ModelManager } from "./model-manager.js";
import type { TranscribeOptions, TranscriptionStream, ChineseVariant } from "./types.js";

/**
 * Wraps transcribe-cpp to provide a simpler transcription API.
 * Handles model lifecycle through ModelManager.
 */
export class TranscriptionEngine {
  constructor(readonly modelManager: ModelManager) {}

  /**
   * Transcribe a complete PCM audio buffer.
   * Automatically loads the model if needed.
   */
  async transcribe(
    pcm: Float32Array,
    options: TranscribeOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    const modelId = this.modelManager.getLoadedModelId();
    if (!modelId) throw new Error("No model loaded");

    const model = this.modelManager.getLoadedModel() as any;
    if (!model) throw new Error("Model instance not available");

    signal?.throwIfAborted();

    const result = await model.transcribe(pcm, {
      language: options.language,
    });

    signal?.throwIfAborted();

    let text: string = typeof result === "string" ? result : result?.text ?? "";
    text = text.trim();

    // Post-process Chinese output
    if (text && options.chineseVariant && isChineseLanguage(options.language)) {
      text = await postProcessChinese(text, options.chineseVariant);
    }

    return text;
  }

  /**
   * Create a streaming transcription session if the loaded model supports it.
   * Returns null if streaming is not supported.
   */
  createStream(options: TranscribeOptions): TranscriptionStream | null {
    const model = this.modelManager.getLoadedModel() as any;
    if (!model?.createSession) return null;

    try {
      const session = model.createSession();
      if (!session) return null;

      const stream = session.stream({ language: options.language });
      if (!stream) return null;

      return {
        feed(chunk: Float32Array): void {
          stream.feed(chunk);
        },
        async finalize(): Promise<string> {
          let text: string = await stream.finalize();
          text = text.trim();
          if (text && options.chineseVariant && isChineseLanguage(options.language)) {
            text = await postProcessChinese(text, options.chineseVariant);
          }
          return text;
        },
        cancel(): void {
          stream.reset?.();
        },
      };
    } catch {
      return null;
    }
  }

  /** Shut down the engine and unload models. */
  async shutdown(): Promise<void> {
    this.modelManager.unload();
  }
}

async function postProcessChinese(text: string, variant: ChineseVariant): Promise<string> {
  try {
    return await convertChineseOutput(text, variant);
  } catch {
    // If conversion fails, return original text
    return text;
  }
}
