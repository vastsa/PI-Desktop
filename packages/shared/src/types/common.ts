/** Shared public types grouped by the owning application domain. */
export type BuiltinMode = "plan" | "goal" | "agent";

/**
 * A session operating mode id: a builtin, or a user mode definition id
 * (ADR mode-definitions). Custom ids match `MODE_ID_RE`.
 */
export type Mode = BuiltinMode | (string & {});

const MODE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

/** Normalize mode values at compatibility boundaries. Older persisted and
 * scheduled data used `chat`; it is now the Plan operating state. A valid
 * custom mode id passes through; anything else falls back. */
export function normalizeMode(value: unknown, fallback: Mode = "agent"): Mode {
  if (value === "agent") return "agent";
  if (value === "goal") return "goal";
  if (value === "plan" || value === "chat") return "plan";
  if (typeof value === "string" && MODE_ID_PATTERN.test(value)) return value;
  return fallback;
}

/** Builtin-only normalization for surfaces that have no custom modes
 * (scheduled tasks, RACP remote sessions, settings default mode). */
export function normalizeBuiltinMode(value: unknown, fallback: BuiltinMode = "agent"): BuiltinMode {
  const mode = normalizeMode(value, fallback);
  return mode === "agent" || mode === "plan" || mode === "goal" ? (mode as BuiltinMode) : fallback;
}
