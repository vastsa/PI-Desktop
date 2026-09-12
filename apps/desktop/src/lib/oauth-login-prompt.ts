import type { OAuthPromptRequest } from "@pi-desktop/shared";

/**
 * Plain text prompts may use an empty value as a vendor-defined default. Keep
 * secrets and codes gated because an empty value cannot complete those flows.
 */
export function canSubmitOAuthPrompt(
  prompt: OAuthPromptRequest | null,
  answer: string,
): boolean {
  if (!prompt) return false;
  if (prompt.type === "select") return false;
  return prompt.type === "text" || answer.trim().length > 0;
}
