import type { AppSettings, SubagentStyle } from "./types/settings.js";

export function isSubagentStyle(value: unknown): value is SubagentStyle {
  return value === "transcript" || value === "bar";
}

/** Older or unknown settings retain the transcript-only UI without a write. */
export function resolveSubagentStyle(settings?: Pick<AppSettings, "subagentStyle"> | null): SubagentStyle {
  return settings?.subagentStyle === "bar" ? "bar" : "transcript";
}
