/**
 * Case-insensitive fuzzy matching for the composer autocomplete (D123/D124),
 * with highlight ranges for the menu. Scoring follows pi's file scorer:
 * exact file name > file-name prefix > file-name substring > path substring,
 * plus a directory bonus; a subsequence fallback keeps forgiving matches at
 * the bottom instead of dropping them.
 */

export type FuzzyMatch = {
  score: number;
  /** Half-open [start, end) highlight ranges into the candidate string. */
  ranges: Array<[number, number]>;
};

const SCORE_EXACT_NAME = 100;
const SCORE_NAME_PREFIX = 80;
const SCORE_NAME_SUBSTRING = 50;
const SCORE_PATH_SUBSTRING = 30;
const SCORE_SUBSEQUENCE = 10;
const DIR_BONUS = 10;

/** Merge adjacent per-character hits into contiguous ranges. */
function mergeIndices(indices: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === index) last[1] = index + 1;
    else ranges.push([index, index + 1]);
  }
  return ranges;
}

/** Left-to-right subsequence match; null when `query` is not contained. */
function subsequence(query: string, text: string): number[] | null {
  const indices: number[] = [];
  let at = 0;
  for (const ch of query) {
    const found = text.indexOf(ch, at);
    if (found < 0) return null;
    indices.push(found);
    at = found + 1;
  }
  return indices;
}

/** Match a workspace-relative path against an "@" query. */
export function fuzzyMatchPath(
  query: string,
  path: string,
  kind: "dir" | "file" = "file",
): FuzzyMatch | null {
  const bonus = kind === "dir" ? DIR_BONUS : 0;
  if (!query) return { score: bonus, ranges: [] };

  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf("/") + 1;
  const name = p.slice(nameStart);

  if (!q.includes("/")) {
    if (name === q) {
      return {
        score: SCORE_EXACT_NAME + bonus,
        ranges: [[nameStart, nameStart + q.length]],
      };
    }
    if (name.startsWith(q)) {
      return {
        score: SCORE_NAME_PREFIX + bonus,
        ranges: [[nameStart, nameStart + q.length]],
      };
    }
    const inName = name.indexOf(q);
    if (inName >= 0) {
      return {
        score: SCORE_NAME_SUBSTRING + bonus,
        ranges: [[nameStart + inName, nameStart + inName + q.length]],
      };
    }
  }

  const inPath = p.indexOf(q);
  if (inPath >= 0) {
    return {
      score: SCORE_PATH_SUBSTRING + bonus,
      ranges: [[inPath, inPath + q.length]],
    };
  }

  const indices = subsequence(q, p);
  if (indices) {
    return { score: SCORE_SUBSEQUENCE + bonus, ranges: mergeIndices(indices) };
  }
  return null;
}

/** Match a slash-command name (or title) against a "/" query. */
export function fuzzyMatchCommand(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, ranges: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(q)) {
    return { score: SCORE_EXACT_NAME, ranges: [[0, q.length]] };
  }
  const at = t.indexOf(q);
  if (at >= 0) {
    return { score: SCORE_NAME_SUBSTRING, ranges: [[at, at + q.length]] };
  }
  const indices = subsequence(q, t);
  if (indices) {
    return { score: SCORE_SUBSEQUENCE, ranges: mergeIndices(indices) };
  }
  return null;
}

/**
 * Stable comparator for matched entries: higher score first, then shorter
 * candidate, then lexical order.
 */
export function compareMatches(
  a: { score: number; text: string },
  b: { score: number; text: string },
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.text.length !== b.text.length) return a.text.length - b.text.length;
  return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
}

/**
 * Keep only the `limit` best candidates, sorting that bounded set instead of
 * the whole match list. The composer filters up to the whole workspace file
 * index on every keystroke but shows a fixed handful of rows, so a full sort
 * over every match is work the menu throws away.
 *
 * Insertion into a bounded buffer preserves the exact `compareMatches` order of
 * the returned rows: once the buffer is full a candidate worse than the current
 * worst kept row is rejected with a single comparison, which is the common case.
 */
export function selectBestMatches<T>(
  candidates: Iterable<T>,
  limit: number,
  key: (candidate: T) => { score: number; text: string },
): T[] {
  if (limit <= 0) return [];
  const kept: T[] = [];
  const keys: Array<{ score: number; text: string }> = [];
  for (const candidate of candidates) {
    const candidateKey = key(candidate);
    if (
      kept.length === limit &&
      compareMatches(candidateKey, keys[kept.length - 1]!) >= 0
    ) {
      continue;
    }
    let at = kept.length;
    while (at > 0 && compareMatches(candidateKey, keys[at - 1]!) < 0) at -= 1;
    kept.splice(at, 0, candidate);
    keys.splice(at, 0, candidateKey);
    if (kept.length > limit) {
      kept.pop();
      keys.pop();
    }
  }
  return kept;
}
