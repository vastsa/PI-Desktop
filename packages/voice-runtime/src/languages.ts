/** Common language codes used in voice recognition. */
export const SUPPORTED_LANGUAGES = [
  { code: "zh", label: "Chinese (Mandarin)" },
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "de", label: "German" },
  { code: "fr", label: "French" },
  { code: "es", label: "Spanish" },
  { code: "pt", label: "Portuguese" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "yue", label: "Chinese (Cantonese)" },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]["code"];

/** Find a language label by its code. */
export function languageLabel(code: string): string {
  const entry = SUPPORTED_LANGUAGES.find((l) => l.code === code);
  return entry?.label ?? code;
}
