import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ModelInfo, ModelState, ModelStatus } from "./types.js";
import { findModel, getCatalog } from "./model-catalog.js";

/**
 * Manages model discovery, download, loading, and unloading.
 *
 * - Models are cached in `cacheDir` (typically ~/.cache/pi-desktop/voice-models/).
 * - Loading uses transcribe-cpp's TranscribeModel (lazy-imported).
 * - Only one model is loaded at a time.
 */
export class ModelManager extends EventEmitter {
  private states = new Map<string, ModelState>();
  private loadedModelId: string | null = null;
  private loadedModel: unknown = null; // TranscribeModel instance (lazy typed)

  constructor(private readonly cacheDir: string) {
    super();
    this.initializeStates();
  }

  private initializeStates(): void {
    for (const info of getCatalog()) {
      const localPath = this.modelPath(info);
      const downloaded = existsSync(localPath);
      this.states.set(info.id, {
        info,
        status: downloaded ? "downloaded" : "not-downloaded",
        localPath: downloaded ? localPath : undefined,
      });
    }
  }

  private modelPath(info: ModelInfo): string {
    return path.join(this.cacheDir, info.id, info.hfFilename);
  }

  /** Get all known model states. */
  getAllStates(): ModelState[] {
    return [...this.states.values()];
  }

  /** Get a single model state. */
  getState(modelId: string): ModelState | undefined {
    return this.states.get(modelId);
  }

  /** Get the currently loaded model ID. */
  getLoadedModelId(): string | null {
    return this.loadedModelId;
  }

  /**
   * Download a model from HuggingFace Hub with progress reporting.
   * Returns an async generator yielding progress 0–1.
   */
  async *download(
    modelId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<number, void, unknown> {
    const info = findModel(modelId);
    if (!info) throw new Error(`Unknown model: ${modelId}`);

    const state = this.states.get(modelId)!;
    if (state.status === "downloaded" || state.status === "loaded") {
      yield 1;
      return;
    }

    this.updateState(modelId, { status: "downloading", downloadProgress: 0 });

    try {
      const { downloadModel } = await import("./model-downloader.js");
      const targetDir = path.join(this.cacheDir, modelId);

      for await (const progress of downloadModel(info, targetDir, signal)) {
        this.updateState(modelId, { status: "downloading", downloadProgress: progress });
        yield progress;
      }

      const localPath = this.modelPath(info);
      this.updateState(modelId, {
        status: "downloaded",
        downloadProgress: 1,
        localPath,
      });
      yield 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateState(modelId, {
        status: "error",
        error: `Download failed: ${message}`,
      });
      throw error;
    }
  }

  /** Delete a downloaded model. */
  async deleteModel(modelId: string): Promise<void> {
    if (this.loadedModelId === modelId) {
      this.unload();
    }

    const info = findModel(modelId);
    if (!info) return;

    const modelDir = path.join(this.cacheDir, modelId);
    const { rm } = await import("node:fs/promises");
    await rm(modelDir, { recursive: true, force: true });
    this.updateState(modelId, { status: "not-downloaded", localPath: undefined });
  }

  /** Ensure a model is loaded into memory. Lazy-imports transcribe-cpp. */
  async ensureLoaded(modelId: string): Promise<void> {
    if (this.loadedModelId === modelId && this.loadedModel) return;

    const state = this.states.get(modelId);
    if (!state || !state.localPath) {
      throw new Error(`Model ${modelId} is not downloaded`);
    }

    // Unload any previously loaded model
    this.unload();

    this.updateState(modelId, { status: "loading" });

    try {
      const transcribeCpp = await import("transcribe-cpp");
      const model = await transcribeCpp.TranscribeModel.load(state.localPath);
      this.loadedModel = model;
      this.loadedModelId = modelId;
      this.updateState(modelId, { status: "loaded" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateState(modelId, { status: "error", error: `Load failed: ${message}` });
      throw error;
    }
  }

  /** Get the loaded transcribe-cpp model instance. */
  getLoadedModel(): unknown {
    return this.loadedModel;
  }

  /** Unload the currently loaded model to free memory. */
  unload(): void {
    if (this.loadedModel && typeof (this.loadedModel as any).dispose === "function") {
      try {
        (this.loadedModel as any).dispose();
      } catch {
        // Best-effort cleanup
      }
    }
    if (this.loadedModelId) {
      const state = this.states.get(this.loadedModelId);
      if (state && state.status === "loaded") {
        this.updateState(this.loadedModelId, { status: "downloaded" });
      }
    }
    this.loadedModel = null;
    this.loadedModelId = null;
  }

  private updateState(modelId: string, patch: Partial<ModelState>): void {
    const current = this.states.get(modelId);
    if (!current) return;
    const next = { ...current, ...patch };
    this.states.set(modelId, next);
    this.emit("modelStateChanged", modelId, next);
  }
}
