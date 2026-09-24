import { isChineseLanguage, convertChineseOutput } from "./chinese.js";
import type { ModelManager } from "./model-manager.js";
import type { TranscribeModel } from "transcribe-cpp";
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

    const model: TranscribeModel | null = this.modelManager.getLoadedModel();
    if (!model) throw new Error("Model instance not available");

    signal?.throwIfAborted();

    const result = await model.transcribe(pcm, {
      language: options.language,
    });

    signal?.throwIfAborted();

    let text = result.text;
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
    const model: TranscribeModel | null = this.modelManager.getLoadedModel();
    if (!model?.capabilities.supportsStreaming) return null;

    try {
      const session = model.createSession();
      if (!session) return null;

      const streamPromise = session.stream({ language: options.language });
      let queue = Promise.resolve();
      let cancelled = false;

      return {
        feed(chunk: Float32Array): void {
          queue = queue
            .then(async () => {
              if (cancelled) return;
              const stream = await streamPromise;
              await stream.feed(chunk);
            })
            .catch(() => undefined);
        },
        async finalize(): Promise<string> {
          await queue;
          if (cancelled) throw new DOMException("Transcription cancelled", "AbortError");
          const stream = await streamPromise;
          await stream.finalize();
          let text = stream.text.full;
          text = text.trim();
          if (text && options.chineseVariant && isChineseLanguage(options.language)) {
            text = await postProcessChinese(text, options.chineseVariant);
          }
          return text;
        },
        cancel(): void {
          cancelled = true;
          queue = queue
            .then(async () => {
              const stream = await streamPromise;
              stream.reset();
            })
            .catch(() => undefined);
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
