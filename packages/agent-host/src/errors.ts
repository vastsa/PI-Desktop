import type { RacpRemoteError } from "@pi-desktop/shared";
import { RACP_ERROR_CODES, type RacpErrorCode } from "@pi-desktop/shared";

/**
 * A failure that crosses the Agent Host boundary. The code is a shared
 * `AppError` code (spec §13); `retriable` follows the RACP table unless the
 * thrower overrides it.
 */
export class RacpError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly details?: unknown;

  constructor(code: RacpErrorCode | string, message: string, options: { retriable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = "RacpError";
    this.code = code;
    const registered = (RACP_ERROR_CODES as Record<string, { retriable: boolean | "maybe" }>)[code];
    this.retriable = options.retriable ?? (registered ? registered.retriable === true : false);
    this.details = options.details;
  }

  toRemoteError(traceId: string): RacpRemoteError {
    return {
      code: this.code,
      message: this.message,
      retriable: this.retriable,
      traceId,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function racpError(
  code: RacpErrorCode | string,
  message: string,
  options?: { retriable?: boolean; details?: unknown },
): RacpError {
  return new RacpError(code, message, options);
}

export function isRacpError(value: unknown): value is RacpError {
  return value instanceof RacpError;
}
