/**
 * Text normalization shared by launcher matching and tile rendering.
 *
 * Kept separate from the matching rules so the normalization can be tested on
 * its own: every rule in `launcher-search.ts` compares normalized strings, and a
 * change here silently reorders every section.
 */
import { pinyin } from "pinyin-pro";

/**
 * Fold a display string into the comparable form the launcher matches with:
 * diacritics removed, lower-cased, and stripped of everything that is not a
 * letter or a number. `VS Code` and `vscode` therefore compare equal.
 */
export function normalizeLauncherText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

/** Full pinyin and pinyin initials, both normalized. */
export function launcherPinyinTokens(value: string): {
  full: string;
  initials: string;
} {
  return {
    full: normalizeLauncherText(
      pinyin(value, { toneType: "none", type: "array" }).join(""),
    ),
    initials: normalizeLauncherText(
      pinyin(value, {
        pattern: "first",
        toneType: "none",
        type: "array",
      }).join(""),
    ),
  };
}

/**
 * One-character tile fallback for an item with no icon. Grapheme-aware enough
 * for the launcher's own labels: it takes the first code point, so an emoji or a
 * Chinese character is never split into half a surrogate pair.
 */
export function launcherMonogram(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?";
}
