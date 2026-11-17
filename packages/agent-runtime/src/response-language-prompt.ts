/** The launch adapter supplies the resolved application locale, never "auto". */
export function responseLanguagePrompt(locale?: string): string | undefined {
  if (!locale?.trim()) return undefined;
  return `Use the current application language (${locale.trim()}) for thinking, reasoning, progress updates, and final responses unless the user explicitly requests a different language. Keep code, identifiers, paths, commands, and quoted text in their required language.`;
}
