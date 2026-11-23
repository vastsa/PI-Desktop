/**
 * Bounds of one codemode execution (ADR codemode-sandbox-boundary). They cap
 * what a model-written script can cost: VM memory, wall time, the number and
 * size of nested calls it records, model fan-out, and the text it returns.
 */
export const CODEMODE_TOOL_NAME = "codemode";

export const CODEMODE_LIMITS = {
  /** QuickJS heap cap; overruns fail inside the script as `InternalError: out of memory`. */
  memoryLimitBytes: 256 * 1024 * 1024,
  /** Source size accepted from the model. */
  maxCodeChars: 64 * 1024,
  /** Default and hard deadline per script, including nested tool time. */
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 600_000,
  /** Nested tool and model calls one script may start; later calls reject. */
  maxCalls: 256,
  /** Arguments retained in the call record, per call and in total. */
  maxArgumentBytesPerCall: 8 * 1024,
  maxArgumentBytesTotal: 32 * 1024,
  /** Error text retained per recorded call. */
  maxErrorChars: 500,
  /** Model calls one script may have in flight; the rest queue in call order. */
  maxConcurrentModelCalls: 4,
  /** Sub-model completion bounds. */
  maxCompletionPromptChars: 200_000,
  defaultCompletionOutputTokens: 4_096,
  maxCompletionOutputTokens: 16_384,
  /** Output returned to the model, in estimated tokens (4 chars each). */
  defaultMaxOutputTokens: 10_000,
  maxOutputTokens: 50_000,
  /** Workers shared by every session in this sidecar process. */
  maxWorkers: 2,
  /** How long a script waits for a free worker before failing. */
  workerWaitMs: 60_000,
} as const;

export const CODEMODE_CHARS_PER_TOKEN = 4;
