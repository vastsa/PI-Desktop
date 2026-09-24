/**
 * Ambient declarations for optional native dependencies.
 * These modules are loaded dynamically at runtime and may not be installed
 * during development or on all platforms.
 */

declare module "opencc-js" {
  interface ConverterOptions {
    from: string;
    to: string;
  }
  const OpenCC: {
    Converter(options: ConverterOptions): (text: string) => string;
  };
  export default OpenCC;
}

declare module "transcribe-cpp" {
  interface TranscribeModel {
    transcribe(
      pcm: Float32Array,
      options?: { language?: string },
    ): Promise<{ text: string }>;
    createSession(): TranscribeSession;
    readonly capabilities: { languages: string[]; supportsStreaming: boolean };
    dispose(): void;
  }
  interface TranscribeSession {
    stream(options?: { language?: string }): Promise<TranscribeStream>;
  }
  interface TranscribeStream {
    feed(chunk: Float32Array): Promise<unknown>;
    finalize(): Promise<unknown>;
    readonly text: { full: string };
    reset(): void;
  }
  const TranscribeModel: {
    load(modelPath: string): Promise<TranscribeModel>;
  };
  export { TranscribeModel };
}

declare module "@huggingface/hub" {
  interface DownloadFileOptions {
    repo: string;
    path: string;
    revision?: string;
    requestInit?: RequestInit;
  }
  function downloadFile(options: DownloadFileOptions): Promise<Blob | null>;
  export { downloadFile };
}
