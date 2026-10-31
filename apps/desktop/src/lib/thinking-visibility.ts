import type { AppSettings } from "@pi-desktop/shared";

/**
 * Resolve whether the transcript shows model reasoning.
 *
 * `showThinking` is the current preference and wins whenever it is a boolean.
 * `thinkingDisplayMode` is the legacy field: an explicit `compact` hides
 * reasoning while `detailed`, an unknown value, or an absent field shows it.
 * Absent settings therefore show reasoning, matching the legacy default. This
 * resolver is presentation-only and never controls turn-process folding.
 */
export function resolveShowThinking(
  settings:
    | Pick<AppSettings, "showThinking" | "thinkingDisplayMode">
    | null
    | undefined,
): boolean {
  const value = settings?.showThinking;
  if (typeof value === "boolean") return value;
  return settings?.thinkingDisplayMode !== "compact";
}
