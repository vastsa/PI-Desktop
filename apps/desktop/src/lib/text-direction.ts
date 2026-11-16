/*
 * Content-aware paragraph direction for mixed RTL/LTR chat text (#2388).
 *
 * Relying on the first strong character (the `dir="auto"` / first-strong rule)
 * scrambles paragraphs that open with an English word but are otherwise
 * Persian/Arabic: the whole paragraph gets an LTR base direction and the RTL
 * runs, punctuation, and parentheses land on the wrong side. Instead we count
 * strong LTR and RTL characters and let the majority script pick the
 * paragraph's base direction; paragraphs without any strong character stay
 * neutral ("auto") so the renderer's first-strong fallback still applies.
 */

const RTL_STRONG =
  /[\u0590-\u05FF\u0600-\u065F\u066A-\u066F\u06FA-\u06FF\u0700-\u074F\u0750-\u077F\u07C0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g;
const LTR_STRONG = /[A-Za-z\u00C0-\u02AF\u0370-\u03FF\u0400-\u052F]/g;

export type TextDirection = "ltr" | "rtl" | "auto";

export function countStrongCharacters(text: string): { ltr: number; rtl: number } {
  const rtl = (text.match(RTL_STRONG) ?? []).length;
  const ltr = (text.match(LTR_STRONG) ?? []).length;
  return { ltr, rtl };
}

/**
 * Base direction for a paragraph of chat text. Returns "rtl" when RTL strong
 * characters outnumber LTR ones, "ltr" when LTR outnumber RTL, and "auto"
 * when neither script appears (punctuation-only or other neutral runs).
 */
export function detectTextDirection(text: string): TextDirection {
  const { ltr, rtl } = countStrongCharacters(text);
  if (rtl === 0 && ltr === 0) return "auto";
  return rtl > ltr ? "rtl" : "ltr";
}

/** Value for a `dir` attribute; undefined keeps the element direction-agnostic. */
export function directionAttr(text: string): "ltr" | "rtl" | undefined {
  const direction = detectTextDirection(text);
  return direction === "auto" ? undefined : direction;
}
