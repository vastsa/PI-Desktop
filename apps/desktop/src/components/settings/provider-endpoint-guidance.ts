import type { CatalogApiStyle } from "@pi-desktop/shared";

export function getBaseUrlIssue(value: string): "invalid" | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return !["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash ? "invalid" : null;
  } catch {
    return "invalid";
  }
}

const OPERATIONS: ReadonlyArray<readonly [string, CatalogApiStyle]> = [
  ["/chat/completions", "chat_completions"],
  ["/responses", "responses"],
  ["/messages", "anthropic_messages"],
];

/** URL evidence is a suggestion, never a successful capability probe. */
export function endpointSuggestion(value: string, current: CatalogApiStyle):
  { baseUrl: string; apiStyle: CatalogApiStyle } | undefined {
  if (!value.trim() || getBaseUrlIssue(value)) return undefined;
  const url = new URL(value.trim());
  const path = url.pathname.replace(/\/+$/, "");
  for (const [suffix, apiStyle] of OPERATIONS) {
    if (!path.endsWith(suffix)) continue;
    if (current === apiStyle ||
        (apiStyle === "chat_completions" && current === "opencode_go") ||
        (apiStyle === "responses" && current === "openai_codex_responses") ||
        (apiStyle === "anthropic_messages" && current === "pi_messages")) return undefined;
    return { baseUrl: `${url.origin}${path.slice(0, -suffix.length)}`, apiStyle };
  }
  return undefined;
}

/** Strip only operations belonging to the selected protocol. */
export function normalizeBaseUrlInput(value: string, apiStyle: CatalogApiStyle): string {
  const trimmed = value.trim();
  if (!trimmed || getBaseUrlIssue(trimmed)) return trimmed;
  const normalized = trimmed.replace(/\/+$/, "");
  const wireStyle = apiStyle === "opencode_go" ? "chat_completions"
    : apiStyle === "openai_codex_responses" ? "responses"
    : apiStyle === "pi_messages" ? "anthropic_messages" : apiStyle;
  const suffixes = [...OPERATIONS.filter(([, style]) => style === wireStyle).map(([suffix]) => suffix), "/models"];
  const suffix = suffixes.find((item) => normalized.toLowerCase().endsWith(item));
  return suffix ? normalized.slice(0, -suffix.length).replace(/\/+$/, "") : normalized;
}
