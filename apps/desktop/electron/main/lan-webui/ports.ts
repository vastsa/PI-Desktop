/** A safe, user-facing failure: only `status` and `code` reach the browser. */
export class LanError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** An authenticated browser request after transport checks. */
export interface LanRequest {
  method: "GET" | "POST";
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  deviceId: string;
}

export type LanChange = { sessionId?: string };
