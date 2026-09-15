/**
 * Keep Electron's default "A JavaScript error occurred in the main process"
 * dialog from a stray main-process throw. Host and sidecar stay supervised;
 * a Chromium header conversion or a closed TTY is not a reason to lose them.
 */

import { redactValue } from "./logger.ts";

/** Matches `isBrokenPipeError` in logger.ts without importing that module. */
function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "EPIPE" || code === "EIO";
}

export type MainProcessErrorKind = "uncaughtException" | "unhandledRejection";

export type MainProcessErrorCode =
  | "NON_ASCII_HTTP_HEADER"
  | "EPIPE"
  | "UNCAUGHT_EXCEPTION"
  | "UNHANDLED_REJECTION";

export type MainProcessErrorRecord = {
  kind: MainProcessErrorKind;
  message: string;
  code: MainProcessErrorCode;
  recoverable: boolean;
  detail: string;
};

export type MainProcessErrorSink = {
  emit: (record: MainProcessErrorRecord) => void;
};

let installed = false;
let sink: MainProcessErrorSink | null = null;

/** Chromium/undici throws this when a response header is not a ByteString. */
export function isNonAsciiHttpHeaderError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    message.includes("Cannot convert argument to a ByteString")
  );
}

export function describeMainProcessError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function classifyMainProcessError(
  kind: MainProcessErrorKind,
  error: unknown,
): Omit<MainProcessErrorRecord, "detail"> {
  const message =
    kind === "unhandledRejection"
      ? "unhandled promise rejection in main"
      : "uncaught exception in main";
  if (isNonAsciiHttpHeaderError(error)) {
    return { kind, message, code: "NON_ASCII_HTTP_HEADER", recoverable: true };
  }
  if (isBrokenPipeError(error)) {
    return { kind, message, code: "EPIPE", recoverable: true };
  }
  return {
    kind,
    message,
    code: kind === "unhandledRejection" ? "UNHANDLED_REJECTION" : "UNCAUGHT_EXCEPTION",
    recoverable: false,
  };
}

function defaultEmit(record: MainProcessErrorRecord): void {
  try {
    const payload = {
      ts: new Date().toISOString(),
      level: "error",
      channel: "app",
      category: "runtime",
      event: "main.process.error",
      message: redactValue(record.message),
      code: redactValue(record.code),
      data: redactValue({
        kind: record.kind,
        recoverable: record.recoverable,
        detail: record.detail,
      }),
    };
    console.error(`[app/runtime] ${JSON.stringify(payload)}`);
  } catch {
    // Console may already be a closed pipe; never throw from this path.
  }
}

export function reportMainProcessError(
  kind: MainProcessErrorKind,
  error: unknown,
): MainProcessErrorRecord {
  const record: MainProcessErrorRecord = {
    ...classifyMainProcessError(kind, error),
    detail: describeMainProcessError(error),
  };
  try {
    (sink ?? { emit: defaultEmit }).emit(record);
  } catch {
    defaultEmit(record);
  }
  return record;
}

/**
 * Register once. A later call only replaces the log sink (boot starts with
 * console, then the NDJSON logger attaches once it exists).
 */
export function installMainProcessErrorHandlers(next?: MainProcessErrorSink): void {
  if (next) sink = next;
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (error) => {
    reportMainProcessError("uncaughtException", error);
  });
  process.on("unhandledRejection", (reason) => {
    reportMainProcessError("unhandledRejection", reason);
  });
}
