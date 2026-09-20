const CHIP_TOKEN_BASE = 0xe000;
const CHIP_TOKEN_END = 0xf8ff;
let chipTokenSequence = 0;

export function nextChipToken(): string {
  const range = CHIP_TOKEN_END - CHIP_TOKEN_BASE + 1;
  chipTokenSequence = (chipTokenSequence + 1) % range;
  return String.fromCodePoint(CHIP_TOKEN_BASE + chipTokenSequence);
}

export function isChipTokenChar(char: string): boolean {
  if (char.length !== 1) return false;
  const code = char.codePointAt(0) ?? 0;
  return code >= CHIP_TOKEN_BASE && code <= CHIP_TOKEN_END;
}

