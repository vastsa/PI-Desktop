/**
 * Session-access policy for the plugin broker (ADR 0341).
 *
 * Keeping it here — as pure functions over a granted-permission set and a raw
 * request payload — is deliberate: the `.all` family is the widest grant the
 * plugin platform can hand out, and the decision "which sessions may this call
 * touch" is worth testing without standing up a plugin process, a host RPC
 * channel, or Electron.
 */

/** The three session verbs that have both an `.own` and an `.all` grant. */
export const SESSION_ACCESS_VERBS = ["read", "update", "delete"] as const;

export type SessionAccessVerb = (typeof SESSION_ACCESS_VERBS)[number];

/** The scope a call may address, or `null` when the plugin holds neither grant. */
export type SessionAccessScope = "own" | "all";

/**
 * Resolve the scope one granted-permission set buys for a session verb.
 *
 * `.all` is a separate grant, never a widening of `.own`, and it wins when a
 * manifest declares both: a plugin that asked for the whole directory does not
 * get a narrower answer because it also kept the old one.
 */
export function resolveSessionScope(
  permissions: ReadonlySet<string>,
  verb: SessionAccessVerb,
): SessionAccessScope | null {
  if (permissions.has(`session.${verb}.all`)) return "all";
  if (permissions.has(`session.${verb}.own`)) return "own";
  return null;
}

/**
 * The grant each message-level write needs. These have no `.own` form: writing
 * into a transcript is only ever an `.all` capability.
 */
export const SESSION_WRITE_GRANTS = {
  appendMessage: "session.update.all",
  replaceMessages: "session.update.all",
  deleteMessage: "session.delete.all",
  truncateFrom: "session.delete.all",
} as const satisfies Record<string, string>;

export type SessionWriteApi = keyof typeof SESSION_WRITE_GRANTS;

/** Which part of one write payload a caller is shaping. */
export type SessionWriteShape = "message" | "messages" | "messageId" | "truncate";

/** A rejected payload, in the shape the plugin broker turns into `apiError`. */
export type SessionAccessProblem = { code: string; message: string };

/** Host ceilings, restated here so a plugin gets a typed error before dispatch. */
export const MAX_SESSION_ID_CHARS = 128;
export const MAX_MUTATION_MESSAGES = 2_000;
export const MAX_MUTATION_CONTENT_BYTES = 512 * 1024;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Bound one message-level write payload.
 *
 * Returns `null` when the payload is acceptable and the problem otherwise, so
 * the caller keeps ownership of how the failure is raised and audited. The host
 * re-checks every rule here; this copy exists so a payload is refused before it
 * crosses the RPC boundary, not after.
 */
export function describeSessionWriteProblem(
  input: unknown,
  shape: SessionWriteShape,
): SessionAccessProblem | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return problem("input must be an object");
  }
  const record = input as Record<string, unknown>;
  const sessionId = record.sessionId;
  if (
    typeof sessionId !== "string" ||
    !sessionId.trim() ||
    sessionId.length > MAX_SESSION_ID_CHARS
  ) {
    return problem("sessionId must be a non-empty string");
  }
  switch (shape) {
    case "message":
      return describeMessagesProblem([record.message], "message");
    case "messages":
      return describeMessagesProblem(record.messages, "messages");
    case "messageId":
      return typeof record.messageId === "string" && record.messageId.trim()
        ? null
        : problem("messageId must be a non-empty string");
    default: {
      const { fromMessageId, keepCount } = record;
      if (fromMessageId !== undefined && typeof fromMessageId !== "string") {
        return problem("fromMessageId must be a string");
      }
      if (
        keepCount !== undefined &&
        (typeof keepCount !== "number" || !Number.isInteger(keepCount) || keepCount < 0)
      ) {
        return problem("keepCount must be a non-negative integer");
      }
      return fromMessageId === undefined && keepCount === undefined
        ? problem("fromMessageId or keepCount is required")
        : null;
    }
  }
}

function problem(message: string, code = "INVALID_PARAMS"): SessionAccessProblem {
  return { code, message };
}

function describeMessagesProblem(value: unknown, field: string): SessionAccessProblem | null {
  if (!Array.isArray(value)) return problem(`${field} must be an array`);
  if (value.length > MAX_MUTATION_MESSAGES) {
    return problem(
      `${field} must contain at most ${MAX_MUTATION_MESSAGES} entries`,
      "LIMIT_EXCEEDED",
    );
  }
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return problem(`${field} entries must be objects`);
    }
    const row = entry as Record<string, unknown>;
    if (!["user", "assistant", "tool"].includes(String(row.role))) {
      return problem(`${field} role is invalid`);
    }
    if (typeof row.content !== "string") {
      return problem(`${field} content must be a string`);
    }
    if (Buffer.byteLength(row.content, "utf8") > MAX_MUTATION_CONTENT_BYTES) {
      return problem(`${field} content exceeds 512 KiB`, "LIMIT_EXCEEDED");
    }
    if (typeof row.createdAt !== "string" || !RFC3339.test(row.createdAt)) {
      return problem(`${field} createdAt must be RFC3339`);
    }
    if (
      row.id !== undefined &&
      (typeof row.id !== "string" || !row.id.trim() || row.id.length > MAX_SESSION_ID_CHARS)
    ) {
      return problem(`${field} id must be a non-empty string`);
    }
  }
  return null;
}
