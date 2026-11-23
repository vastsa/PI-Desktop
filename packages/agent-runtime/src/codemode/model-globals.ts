/**
 * `models.*` globals for codemode scripts. Scripts never receive a model
 * object, base URL, header, or credential: they name a capability and the
 * session runtime dispatches it with its own bindings. Every call is a row in
 * the script's call record and goes through one concurrency limiter.
 */
import type { CodemodeTool } from "@earendil-works/pi-codemode";
import type { JevClassification } from "../jev-classifier-tool.js";
import { CODEMODE_LIMITS } from "./limits.js";
import type { NestedCallRecorder } from "./nested-calls.js";

/** Allowlisted public metadata. Never spread a model or provider object into this. */
export type CodemodeModelInfo = {
  kind: "chat" | "classifier" | "image";
  providerId: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
};

export type CodemodeCompletionRequest = {
  prompt: string;
  system?: string;
  maxOutputTokens: number;
};

/** What the session runtime provides. Absent capabilities are not exposed. */
export interface CodemodeModelHost {
  list(): CodemodeModelInfo[];
  /** Text completion on the session's own model binding; usage is recorded by the host. */
  complete?(request: CodemodeCompletionRequest, signal: AbortSignal): Promise<{ text: string }>;
  /** TypeSafe Jev classification; usage is recorded by the host. */
  classify?(params: unknown, signal: AbortSignal): Promise<JevClassification>;
}

type Limiter = <T>(run: () => Promise<T>) => Promise<T>;

function createLimiter(limit: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Validate a script's completion request against the documented bounds. */
export function parseCompletionRequest(value: unknown): CodemodeCompletionRequest {
  const shape = 'Expected { prompt: string, system?: string, maxOutputTokens?: number }.';
  if (!isRecord(value)) throw new Error(`models.complete() expects a request object. ${shape}`);
  const { prompt, system, maxOutputTokens } = value;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error(`models.complete() requires a non-empty prompt string. ${shape}`);
  }
  if (system !== undefined && typeof system !== "string") {
    throw new Error(`models.complete() system must be a string. ${shape}`);
  }
  const chars = prompt.length + (system?.length ?? 0);
  if (chars > CODEMODE_LIMITS.maxCompletionPromptChars) {
    throw new Error(`models.complete() input is ${chars} characters; the limit is ${CODEMODE_LIMITS.maxCompletionPromptChars}. Filter it in the script first.`);
  }
  let tokens: number = CODEMODE_LIMITS.defaultCompletionOutputTokens;
  if (maxOutputTokens !== undefined) {
    if (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new Error("models.complete() maxOutputTokens must be a positive integer.");
    }
    tokens = Math.min(maxOutputTokens, CODEMODE_LIMITS.maxCompletionOutputTokens);
  }
  return { prompt, ...(system ? { system } : {}), maxOutputTokens: tokens };
}

export type ModelGlobalsOptions = {
  callerId: string;
  host: CodemodeModelHost | undefined;
  recorder: NestedCallRecorder;
  /** Runs the session's GenerateImages tool through the nested pipeline, when callable. */
  generateImages?: (args: unknown, signal: AbortSignal) => Promise<unknown>;
};

export function createModelGlobals(options: ModelGlobalsOptions): CodemodeTool[] {
  const { host, recorder, callerId } = options;
  const limit = createLimiter(CODEMODE_LIMITS.maxConcurrentModelCalls);
  let count = 0;
  const models = host?.list() ?? [];
  const chat = models.find((model) => model.kind === "chat");
  const classifier = models.find((model) => model.kind === "classifier");

  const recordedCall = async <T>(name: string, model: CodemodeModelInfo | undefined, run: () => Promise<T>): Promise<T> => {
    const record = recorder.start(
      `${callerId}/${name}/${++count}`,
      name,
      "model",
      model ? { model: `${model.providerId}/${model.id}` } : {},
    );
    try {
      const value = await limit(run);
      recorder.finish(record, "ok");
      return value;
    } catch (error) {
      recorder.finish(record, "error", errorText(error));
      throw error;
    }
  };

  const globals: CodemodeTool[] = [
    {
      name: "models.list",
      description: "Public metadata of the models this script can use.",
      execute: () => models.map((model) => ({ ...model })),
    },
  ];
  if (host?.complete && chat) {
    const complete = host.complete.bind(host);
    globals.push({
      name: "models.complete",
      description: "Text completion on this session's model: { prompt, system?, maxOutputTokens? } -> { text }.",
      execute: (args, { signal }) => {
        const request = parseCompletionRequest(args);
        return recordedCall("models.complete", chat, async () => {
          const { text } = await complete(request, signal);
          return { text, model: { providerId: chat.providerId, id: chat.id } };
        });
      },
    });
  }
  if (host?.classify && classifier) {
    const classify = host.classify.bind(host);
    globals.push({
      name: "models.classify",
      description: "TypeSafe Jev structured classification: { state, questions } -> { answers }.",
      execute: (args, { signal }) => recordedCall("models.classify", classifier, async () => {
        const result = await classify(args, signal);
        if (!result.ok) throw new Error(result.message);
        return { answers: result.answers };
      }),
    });
  }
  if (options.generateImages) {
    const generate = options.generateImages;
    globals.push({
      name: "models.generateImages",
      description: "Generate or edit images through this session's GenerateImages tool; takes that tool's arguments.",
      // GenerateImages is a nested tool call: it records its own row and usage.
      execute: (args, { signal }) => limit(() => generate(args, signal)),
    });
  }
  return globals;
}
