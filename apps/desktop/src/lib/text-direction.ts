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

// Unicode 17.0 UnicodeData.txt fields General_Category and Bidi_Class:
// https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt
// All Letter characters in the RTL blocks below have Bidi_Class R/AL.
// The 26 neutral modifier letters are Letter but not strong L, R or AL.
// Keep the Letter guard: digits, punctuation and marks inside RTL blocks must
// not vote. Unknown letters follow the JS engine's Unicode property version.
const LETTER = /\p{Letter}/u;
const NEUTRAL_LETTER = /[\u02b9\u02ba\u02c6-\u02cf\u02ec\u0374\u2e2f\ua67f\ua717-\ua71f\ua788]/u;
const RTL_LETTER = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1edff}\u{1ee00}-\u{1eeff}]/u;

export type TextDirection = "ltr" | "rtl" | "auto";

export function countStrongCharacters(text: string): { ltr: number; rtl: number } {
  let ltr = 0;
  let rtl = 0;
  for (const character of text) {
    if (!LETTER.test(character) || NEUTRAL_LETTER.test(character)) continue;
    if (RTL_LETTER.test(character)) rtl++;
    else ltr++;
  }
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
