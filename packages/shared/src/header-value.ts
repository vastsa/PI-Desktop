/**
 * HTTP header values travel as ByteStrings: every UTF-16 code unit must be
 * ≤ U+00FF, and undici (Node's `fetch`) rejects anything else with
 * `TypeError: Cannot convert argument to a ByteString because the character at
 * index N has a value of X which is greater than 255.` — a message a user
 * cannot act on.
 *
 * Two different inputs get fixed differently:
 *
 * - The fullwidth block (U+FF01–U+FF5E) and the ideographic space (U+3000)
 *   are what a Chinese/Japanese IME or a fullwidth-formatted page produces for
 *   plain ASCII. `０` is U+FF10, so it folds back to `0`, which is what the
 *   user meant. This is the compatibility case.
 * - Everything else above U+00FF (Han, emoji, curly quotes) has no wire
 *   representation in a header value; percent- or base64-encoding would send
 *   the server bytes it never decodes. Those are rejected by the callers.
 *
 * Only the fullwidth block is folded. A full NFKC pass is deliberately not
 * used: NFKC would also rewrite halfwidth katakana `ｱ` into U+30A2 and emit
 * combining marks, swapping one unusable value for another.
 */

/**
 * Upper bound for one value. The runtime measures UTF-16 code units here (its
 * name predates this module) while host validation measures UTF-8 bytes, so the
 * host bound is the stricter one — a value the runtime accepts can still be
 * refused on save, never the other way round.
 */
export const HEADER_VALUE_MAX_BYTES = 4096;

export const HEADER_VALUE_FULLWIDTH_FIRST = 0xff01;
export const HEADER_VALUE_FULLWIDTH_LAST = 0xff5e;
export const HEADER_VALUE_FULLWIDTH_TO_ASCII = 0xfee0;
export const HEADER_VALUE_IDEOGRAPHIC_SPACE = 0x3000;

/**
 * What undici's `headerValueRegex` accepts: HTAB, printable ASCII, and the
 * Latin-1 supplement. Anything else (NUL, other C0 controls, DEL, and every
 * code point above U+00FF) fails at request time.
 */
export const HEADER_VALUE_ALLOWED = /^[\t\x20-\x7E\x80-\xFF]*$/;

export type HeaderValueFault = {
  /** Code-unit index in the folded value undici would have converted. */
  index: number;
  codePoint: number;
};

export type HeaderValueInspection = {
  /** Folded and trimmed text; what the caller should send. */
  value: string;
  /** True when folding rewrote the input (it held fullwidth characters). */
  folded: boolean;
  /** First character that cannot travel in a header value, if any. */
  fault: HeaderValueFault | null;
};

/** Fold the fullwidth block and the ideographic space onto ASCII. */
export function foldFullwidthHeaderValue(value: string): string {
  let out = "";
  let changed = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint >= HEADER_VALUE_FULLWIDTH_FIRST &&
      codePoint <= HEADER_VALUE_FULLWIDTH_LAST
    ) {
      out += String.fromCharCode(codePoint - HEADER_VALUE_FULLWIDTH_TO_ASCII);
      changed = true;
    } else if (codePoint === HEADER_VALUE_IDEOGRAPHIC_SPACE) {
      out += " ";
      changed = true;
    } else {
      out += character;
    }
  }
  return changed ? out : value;
}

/**
 * Fold, trim, and report whether the result can be sent. Callers decide what
 * an unusable value means: the host rejects the save and names the character,
 * the runtime drops the row so a stale store cannot blow up a request.
 *
 * The trim is `String.prototype.trim`, which is also what the host mirrors —
 * including U+FEFF, a byte-order mark pasted from a file, and excluding U+0085.
 */
export function inspectHeaderValue(raw: string): HeaderValueInspection {
  const foldedText = foldFullwidthHeaderValue(raw);
  const value = foldedText.trim();
  const folded = foldedText !== raw;
  const fault = firstHeaderValueFault(value);
  return { value, folded, fault };
}

export function firstHeaderValueFault(value: string): HeaderValueFault | null {
  if (HEADER_VALUE_ALLOWED.test(value)) return null;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (
      codePoint === 0x09 ||
      (codePoint >= 0x20 && codePoint <= 0x7e) ||
      (codePoint >= 0x80 && codePoint <= 0xff)
    ) {
      continue;
    }
    return { index, codePoint };
  }
  return null;
}
