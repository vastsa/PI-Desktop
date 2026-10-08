/**
 * Session title generation prompt and lengths (ADR 0322).
 *
 * Shared rather than agent-runtime-local for the same reason as
 * `prompt-enhancement.ts`: the runtime that sends the request, the settings
 * editor that shows the default a user is overriding, and "restore default"
 * must read one copy.
 *
 * The default prompt is the built-in title prompt that shipped with ADR 0186.
 * The only change is that the hard-coded ideal length in rule 3 became the
 * `{{idealLength}}` variable; rendered with the default ideal length it is
 * byte-identical to the original constant.
 *
 * Unlike prompt enhancement, the whole system prompt is overridable: the title
 * output contract is enforced in code (sanitization, truncation, empty-result
 * fallback), and the conversation content is carried by a built-in user
 * message, so a custom prompt can never drop the user's input. Rust host-core
 * validates a stored override (see `crates/host-core/src/rpc/one_shot_settings.rs`);
 * the resolution helpers here are the runtime's defensive second line.
 */

/** Optional placeholder replaced with the effective ideal title length. */
export const SESSION_TITLE_IDEAL_LENGTH_VARIABLE = "{{idealLength}}";

/**
 * Upper bound for a stored custom prompt, in Unicode code points. Mirrored by
 * `MAX_ONE_SHOT_TEMPLATE_CHARS` in host-core; keep the two in step.
 */
export const SESSION_TITLE_PROMPT_MAX_LENGTH = 8000;

/** Ideal title length guidance, in characters (code points). */
export const SESSION_TITLE_IDEAL_LENGTH_DEFAULT = 25;
export const SESSION_TITLE_IDEAL_LENGTH_MIN = 8;
export const SESSION_TITLE_IDEAL_LENGTH_MAX = 60;

/** Hard cap applied to a generated title, in characters (code points). */
export const SESSION_TITLE_MAX_LENGTH_DEFAULT = 80;
export const SESSION_TITLE_MAX_LENGTH_MIN = 16;
export const SESSION_TITLE_MAX_LENGTH_MAX = 200;

/** The built-in title prompt; rule 3 carries `{{idealLength}}`. */
export const SESSION_TITLE_DEFAULT_PROMPT =
  "You generate a short, concise, descriptive session title summarizing the conversation based on the user's initial prompt and context.\n" +
  "Rules:\n" +
  "1. Output ONLY the title text. Do NOT wrap in quotes, brackets, or backticks.\n" +
  "2. Do not include markdown formatting, trailing punctuation, or emojis.\n" +
  `3. Keep it under ${SESSION_TITLE_IDEAL_LENGTH_VARIABLE} characters (or 4-7 words).\n` +
  "4. Use the primary language of the user's prompt (e.g. Chinese for Chinese requests, English for English requests).\n" +
  "5. Focus on the key topic or action (e.g. \"Debug WebSocket reconnect\", \"重构用户认证模块\").";

/** The persisted prompt override and lengths, as stored on `AppSettings`. */
export type SessionTitleSettingsOverrides = {
  /** Off (absent) keeps the built-in prompt even when text is stored. */
  customPrompt?: boolean | null;
  prompt?: string | null;
  idealLength?: number | null;
  maxLength?: number | null;
};

function usablePrompt(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if ([...value].length > SESSION_TITLE_PROMPT_MAX_LENGTH) return undefined;
  return value;
}

/** True when the stored custom prompt is the one currently in force. */
export function isCustomSessionTitlePromptActive(
  overrides: Pick<SessionTitleSettingsOverrides, "customPrompt" | "prompt"> = {},
): boolean {
  return overrides.customPrompt === true && usablePrompt(overrides.prompt) !== undefined;
}

/**
 * Resolve the un-rendered prompt in force. The switch is the gate: a stored
 * prompt is kept for the next time it is turned on, but does not apply until
 * then. A blank or oversized value falls back to the built-in prompt.
 */
export function resolveSessionTitlePrompt(
  overrides: Pick<SessionTitleSettingsOverrides, "customPrompt" | "prompt"> = {},
): string {
  return isCustomSessionTitlePromptActive(overrides)
    ? (overrides.prompt as string)
    : SESSION_TITLE_DEFAULT_PROMPT;
}

/** True when a prompt references the ideal-length variable. */
export function sessionTitlePromptUsesIdealLength(prompt: string): boolean {
  return prompt.includes(SESSION_TITLE_IDEAL_LENGTH_VARIABLE);
}

function integerInRange(
  value: number | null | undefined,
  min: number,
  max: number,
): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

/** True when a value is a storable ideal length. */
export function isValidSessionTitleIdealLength(value: unknown): value is number {
  return (
    integerInRange(
      value as number,
      SESSION_TITLE_IDEAL_LENGTH_MIN,
      SESSION_TITLE_IDEAL_LENGTH_MAX,
    ) !== undefined
  );
}

/** True when a value is a storable truncation length. */
export function isValidSessionTitleMaxLength(value: unknown): value is number {
  return (
    integerInRange(value as number, SESSION_TITLE_MAX_LENGTH_MIN, SESSION_TITLE_MAX_LENGTH_MAX) !==
    undefined
  );
}

/**
 * Effective lengths. Each value is validated on its own and falls back to its
 * default when absent or out of range; the ideal length is then clamped to the
 * truncation length so the prompt never asks for more than is kept.
 */
export function resolveSessionTitleLengths(
  overrides: Pick<SessionTitleSettingsOverrides, "idealLength" | "maxLength"> = {},
): { idealLength: number; maxLength: number } {
  const maxLength =
    integerInRange(overrides.maxLength, SESSION_TITLE_MAX_LENGTH_MIN, SESSION_TITLE_MAX_LENGTH_MAX) ??
    SESSION_TITLE_MAX_LENGTH_DEFAULT;
  const idealLength =
    integerInRange(
      overrides.idealLength,
      SESSION_TITLE_IDEAL_LENGTH_MIN,
      SESSION_TITLE_IDEAL_LENGTH_MAX,
    ) ?? SESSION_TITLE_IDEAL_LENGTH_DEFAULT;
  return { idealLength: Math.min(idealLength, maxLength), maxLength };
}

/**
 * Substitute every `{{idealLength}}`. `split`/`join` never interprets `$&` or
 * `$1` inside a custom prompt as a replacement pattern.
 */
export function renderSessionTitleSystemPrompt(prompt: string, idealLength: number): string {
  return prompt.split(SESSION_TITLE_IDEAL_LENGTH_VARIABLE).join(String(idealLength));
}

/** Resolve and render the system prompt for one title request. */
export function resolveSessionTitleSystemPrompt(
  overrides: SessionTitleSettingsOverrides = {},
): string {
  return renderSessionTitleSystemPrompt(
    resolveSessionTitlePrompt(overrides),
    resolveSessionTitleLengths(overrides).idealLength,
  );
}
