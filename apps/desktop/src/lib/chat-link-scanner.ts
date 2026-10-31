import { beginRenderDiagnostic } from "./render-diagnostics.ts";

/**
 * Bounded candidate scanning for transcript links.
 *
 * File recognition still uses the chat-links grammar, but only against one
 * complete candidate of at most 512 UTF-16 code units. The outer cursor moves
 * monotonically and never retries a failed suffix of an overlong candidate.
 */

export const CHAT_LINK_SCAN_LIMITS = Object.freeze({
  maxScanWorkCodeUnits: 128 * 1024,
  maxFileCandidates: 512,
  maxLinks: 256,
  maxFileCandidateCodeUnits: 512,
  maxUrlCandidateCodeUnits: 16 * 1024,
});

export const KNOWN_BARE_CHAT_FILES = new Set([
  "Makefile",
  "Dockerfile",
  "LICENSE",
  "README",
  "CHANGELOG",
]);

export type ChatLinkScanBudget = {
  workCodeUnits: number;
  fileCandidates: number;
  links: number;
};

export type ChatLinkScanStats = {
  scannedCodeUnits: number;
  candidateWindowCodeUnits: number;
  fileCandidateCount: number;
  linkCount: number;
  workCodeUnits: number;
};

export type ScannedChatLink<T> = {
  start: number;
  end: number;
  raw: string;
  target: T;
};

export type ChatLinkCandidateDisposition = "accept" | "retry" | "skip" | "exhausted";
export type ChatLinkCandidateDispositionResolver = (
  raw: string,
  source: string,
  start: number,
  budget: ChatLinkScanBudget,
  stats: ChatLinkScanStats,
) => ChatLinkCandidateDisposition;

const PATH_WORD_RE = /^[\p{L}\p{N}_@+./\\-]$/u;
const TERMINAL_FILE_RE = /\.[A-Za-z0-9]{1,8}(?:[+@-][\p{L}\p{N}_@+-]*)?(?::\d+(?::\d+|-\d+)?|#[lL]\d+(?:-[lL]?\d+)?)?$/u;
const PROSE_BOUNDARIES = new Set([
  "a", "an", "and", "against", "because", "but", "change", "check",
  "copy", "create", "created", "delete", "edit", "find", "fix", "for",
  "generated", "i", "is", "move", "now", "open", "or", "please", "read",
  "remove", "review", "saved", "see", "show", "then", "this", "update",
  "use", "view", "with", "write", "和", "与", "再看", "然后", "接着",
]);

function createStats(): ChatLinkScanStats {
  return {
    scannedCodeUnits: 0,
    candidateWindowCodeUnits: 0,
    fileCandidateCount: 0,
    linkCount: 0,
    workCodeUnits: 0,
  };
}

export function createChatLinkScanBudget(): ChatLinkScanBudget {
  return { workCodeUnits: 0, fileCandidates: 0, links: 0 };
}

function spend(
  budget: ChatLinkScanBudget,
  stats: ChatLinkScanStats,
  codeUnits: number,
  category: "scan" | "window",
): boolean {
  if (
    codeUnits < 0 ||
    budget.workCodeUnits + codeUnits >
      CHAT_LINK_SCAN_LIMITS.maxScanWorkCodeUnits
  ) {
    return false;
  }
  budget.workCodeUnits += codeUnits;
  stats.workCodeUnits += codeUnits;
  if (category === "scan") stats.scannedCodeUnits += codeUnits;
  else stats.candidateWindowCodeUnits += codeUnits;
  return true;
}

/** Charge bounded candidate-context inspection to this conversion's budget. */
export function spendChatLinkScanWork(
  budget: ChatLinkScanBudget,
  stats: ChatLinkScanStats,
  codeUnits: number,
): boolean {
  return spend(budget, stats, codeUnits, "scan");
}

function codePointWidth(text: string, index: number): number {
  const value = text.codePointAt(index);
  return value !== undefined && value > 0xffff ? 2 : 1;
}

function pathWordAt(text: string, index: number): boolean {
  return PATH_WORD_RE.test(String.fromCodePoint(text.codePointAt(index) ?? 0));
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isHardBoundary(code: number): boolean {
  return (
    code === 0x0a || code === 0x0d || code === 0x2c || code === 0x21 ||
    code === 0x3b || code === 0x3f || code === 0x3c || code === 0x3e ||
    code === 0x22 || code === 0x27 || code === 0x28 || code === 0x29 ||
    code === 0x5b || code === 0x5d || code === 0x7b || code === 0x7d ||
    code === 0xff0c || code === 0xff01 || code === 0xff1b || code === 0xff1f ||
    code === 0xff1a || code === 0x3002
  );
}

function startsHttpUrl(text: string, index: number): boolean {
  const first = text.charCodeAt(index) | 0x20;
  if (first !== 0x68) return false;
  const second = text.charCodeAt(index + 1) | 0x20;
  const third = text.charCodeAt(index + 2) | 0x20;
  const fourth = text.charCodeAt(index + 3) | 0x20;
  if (second !== 0x74 || third !== 0x74 || fourth !== 0x70) return false;
  let offset = 4;
  if ((text.charCodeAt(index + offset) | 0x20) === 0x73) offset += 1;
  return text.slice(index + offset, index + offset + 3) === "://";
}

function urlBreak(code: number): boolean {
  return (
    isWhitespace(code) || code === 0x3c || code === 0x3e || code === 0x22 ||
    code === 0x27 || code === 0x5b || code === 0x5d || code === 0x7b ||
    code === 0x7d
  );
}

function trimUrlPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const code = url.charCodeAt(end - 1);
    if (
      code === 0x2e || code === 0x2c || code === 0x21 || code === 0x3f ||
      code === 0x3b || code === 0x3a || code === 0xff0c || code === 0x3002 ||
      code === 0xff01 || code === 0xff1f || code === 0xff1b || code === 0xff1a
    ) {
      end -= 1;
    } else {
      break;
    }
  }
  return url.slice(0, end);
}

function scanUrlEnd(
  text: string,
  start: number,
  budget: ChatLinkScanBudget,
  stats: ChatLinkScanStats,
): { end: number; overflow: boolean; exhausted: boolean } {
  let depth = 0;
  let index = start;
  let length = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (urlBreak(code)) break;
    if (length >= CHAT_LINK_SCAN_LIMITS.maxUrlCandidateCodeUnits) {
      return { end: index, overflow: true, exhausted: false };
    }
    if (!spend(budget, stats, 1, "scan")) {
      return { end: index, overflow: true, exhausted: true };
    }
    if (code === 0x28) depth += 1;
    else if (code === 0x29) {
      if (depth === 0) break;
      depth -= 1;
    }
    index += 1;
    length += 1;
  }
  return { end: index, overflow: false, exhausted: false };
}

function hasPathMarker(
  text: string,
  start: number,
  budget: ChatLinkScanBudget,
  stats: ChatLinkScanStats,
): { found: boolean; end: number; exhausted: boolean } {
  for (let index = start; index < text.length;) {
    const code = text.charCodeAt(index);
    if (isWhitespace(code) || isHardBoundary(code)) {
      return { found: false, end: index, exhausted: false };
    }
    if (code === 0x2e || code === 0x2f || code === 0x5c || code === 0x40) {
      return { found: true, end: index, exhausted: false };
    }
    const width = codePointWidth(text, index);
    if (!spend(budget, stats, width, "scan")) {
      return { found: false, end: index, exhausted: true };
    }
    index += width;
  }
  return { found: false, end: text.length, exhausted: false };
}

function isTerminalFileToken(token: string): boolean {
  return TERMINAL_FILE_RE.test(token) || KNOWN_BARE_CHAT_FILES.has(token);
}

function candidateWindowEnd(
  text: string,
  start: number,
  budget: ChatLinkScanBudget,
  stats: ChatLinkScanStats,
): { end: number; exhausted: boolean; truncated: boolean } {
  let limit = Math.min(
    text.length,
    start + CHAT_LINK_SCAN_LIMITS.maxFileCandidateCodeUnits,
  );
  if (
    limit < text.length &&
    text.charCodeAt(limit - 1) >= 0xd800 && text.charCodeAt(limit - 1) <= 0xdbff &&
    text.charCodeAt(limit) >= 0xdc00 && text.charCodeAt(limit) <= 0xdfff
  ) limit -= 1;
  let index = start;
  let tokenStart = start;
  while (index < limit) {
    const code = text.charCodeAt(index);
    if (isHardBoundary(code)) {
      return { end: index, exhausted: false, truncated: false };
    }
    if (isWhitespace(code)) {
      const token = text.slice(tokenStart, index);
      if (isTerminalFileToken(token)) {
        return { end: index, exhausted: false, truncated: false };
      }
      while (index < limit && isWhitespace(text.charCodeAt(index))) {
        if (!spend(budget, stats, 1, "window")) {
          return { end: index, exhausted: true, truncated: false };
        }
        index += 1;
      }
      tokenStart = index;
      continue;
    }
    const width = codePointWidth(text, index);
    if (!spend(budget, stats, width, "window")) {
      return { end: index, exhausted: true, truncated: false };
    }
    index += width;
  }
  return {
    end: limit,
    exhausted: false,
    truncated: limit < text.length && !isHardBoundary(text.charCodeAt(limit)),
  };
}

function overlongCandidateEnd(
  text: string,
  candidateStart: number,
  index: number,
  budget: ChatLinkScanBudget,
  stats: ChatLinkScanStats,
): { end: number; exhausted: boolean } {
  const absoluteCandidate =
    text[candidateStart] === "/" ||
    text.startsWith("\\\\", candidateStart) ||
    /^[A-Za-z]:[\\/]/.test(text.slice(candidateStart, candidateStart + 3));
  let tokenStart = index;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (isHardBoundary(code)) return { end: index, exhausted: false };
    if (isWhitespace(code)) {
      const token = text.slice(tokenStart, index);
      if (isTerminalFileToken(token)) {
        return { end: index, exhausted: false };
      }
      // A following prose connector closes an incomplete long candidate. This
      // lets a later independent path be considered without linking a suffix.
      let next = index;
      while (next < text.length && isWhitespace(text.charCodeAt(next))) {
        if (!spend(budget, stats, 1, "scan")) {
          return { end: index, exhausted: true };
        }
        next += 1;
      }
      const nextStart = next;
      while (
        next < text.length &&
        !isWhitespace(text.charCodeAt(next)) &&
        !isHardBoundary(text.charCodeAt(next))
      ) {
        const nextWidth = codePointWidth(text, next);
        if (!spend(budget, stats, nextWidth, "scan")) {
          return { end: index, exhausted: true };
        }
        next += nextWidth;
      }
      const nextToken = text.slice(nextStart, next);
      if (
        isTerminalFileToken(nextToken) &&
        !(absoluteCandidate && /[\\/]/u.test(nextToken)) &&
        !(!absoluteCandidate && text.slice(candidateStart, index).includes("/") && /[\\/]/u.test(nextToken))
      ) {
        return { end: index, exhausted: false };
      }
      if (PROSE_BOUNDARIES.has(nextToken.toLowerCase())) {
        return { end: index, exhausted: false };
      }
      while (index < text.length && isWhitespace(text.charCodeAt(index))) {
        if (!spend(budget, stats, 1, "scan")) {
          return { end: index, exhausted: true };
        }
        index += 1;
      }
      tokenStart = index;
      continue;
    }
    const width = codePointWidth(text, index);
    if (!spend(budget, stats, width, "scan")) {
      return { end: index, exhausted: true };
    }
    index += width;
  }
  return { end: index, exhausted: false };
}

function isCandidateBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = index - codePointWidth(text, index - 1);
  return !pathWordAt(text, previous) && text[previous] !== "/" && text[previous] !== "\\";
}

function sessionLinkEnd(text: string, start: number): number {
  const prefix = "pi-desktop://session/";
  if (!text.startsWith(prefix, start)) return start;
  let end = start + prefix.length;
  const idStart = end;
  while (end < text.length && end - idStart < 65) {
    const code = text.charCodeAt(end);
    if (
      !((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
        (code >= 0x30 && code <= 0x39) || code === 0x5f || code === 0x2d)
    ) break;
    end += 1;
  }
  return end;
}

function scanAtReference<T>(
  text: string,
  start: number,
  budget: ChatLinkScanBudget,
  stats: ChatLinkScanStats,
  resolve: (raw: string) => T | null,
): { end: number; candidate?: ScannedChatLink<T>; exhausted: boolean } {
  const withinCandidateLimit =
    budget.fileCandidates < CHAT_LINK_SCAN_LIMITS.maxFileCandidates;
  if (withinCandidateLimit) {
    budget.fileCandidates += 1;
    stats.fileCandidateCount += 1;
  }
  let end = start;
  const quoted = text[start + 1] === '"';
  if (quoted) {
    end = start + 2;
    while (
      end < text.length &&
      text.charCodeAt(end) !== 0x0a &&
      text.charCodeAt(end) !== 0x0d &&
      text.charCodeAt(end) !== 0x22
    ) {
      const width = codePointWidth(text, end);
      if (!spend(budget, stats, width, "scan")) {
        return { end, exhausted: true };
      }
      end += width;
    }
    if (end < text.length && text.charCodeAt(end) === 0x22) end += 1;
  } else {
    while (end < text.length && !isWhitespace(text.charCodeAt(end))) {
      const width = codePointWidth(text, end);
      if (!spend(budget, stats, width, "scan")) {
        return { end, exhausted: true };
      }
      end += width;
    }
  }
  if (end - start > CHAT_LINK_SCAN_LIMITS.maxFileCandidateCodeUnits) {
    return { end, exhausted: false };
  }
  if (!withinCandidateLimit) return { end, exhausted: false };
  const raw = text.slice(start, end);
  if (!spend(budget, stats, raw.length, "window")) {
    return { end, exhausted: true };
  }
  const target = resolve(raw);
  if (!target) return { end, exhausted: false };
  budget.links += 1;
  stats.linkCount += 1;
  return {
    end,
    candidate: { start, end, raw, target },
    exhausted: false,
  };
}

/** Scan once and resolve references without allowing a candidate to exceed its budget. */
export function scanChatLinkCandidates<T>(
  text: string,
  budget: ChatLinkScanBudget,
  resolve: (raw: string) => T | null,
  disposition: ChatLinkCandidateDispositionResolver,
): { candidates: ScannedChatLink<T>[]; stats: ChatLinkScanStats } {
  const finishDiagnostic = beginRenderDiagnostic("chat-link-scan", {
    sourceLength: text.length,
  });
  const candidates: ScannedChatLink<T>[] = [];
  const stats = createStats();
  let index = 0;
  while (
    index < text.length &&
    budget.workCodeUnits < CHAT_LINK_SCAN_LIMITS.maxScanWorkCodeUnits &&
    budget.links < CHAT_LINK_SCAN_LIMITS.maxLinks
  ) {
    const start = index;
    if (startsHttpUrl(text, index)) {
      const scanned = scanUrlEnd(text, start, budget, stats);
      if (scanned.exhausted) break;
      if (scanned.overflow) {
        index = scanned.end;
        while (index < text.length && !urlBreak(text.charCodeAt(index))) {
          const width = codePointWidth(text, index);
          if (!spend(budget, stats, width, "scan")) break;
          index += width;
        }
        if (budget.workCodeUnits >= CHAT_LINK_SCAN_LIMITS.maxScanWorkCodeUnits) break;
        continue;
      }
      const raw = trimUrlPunctuation(text.slice(start, scanned.end));
      const target = raw ? resolve(raw) : null;
      if (target) {
        candidates.push({ start, end: start + raw.length, raw, target });
        budget.links += 1;
        stats.linkCount += 1;
        index = start + raw.length;
      } else {
        index = Math.max(scanned.end, start + 1);
      }
      continue;
    }

    const sessionEnd = sessionLinkEnd(text, index);
    if (sessionEnd > index) {
      const length = sessionEnd - index;
      if (!spend(budget, stats, length, "scan")) break;
      const raw = text.slice(index, sessionEnd);
      const target = resolve(raw);
      if (target) {
        candidates.push({ start, end: sessionEnd, raw, target });
        budget.links += 1;
        stats.linkCount += 1;
      }
      index = sessionEnd;
      continue;
    }

    const currentCode = text.charCodeAt(index);
    const tildePathStart = currentCode === 0x7e &&
      (text[index + 1] === "/" || text[index + 1] === "\\");
    if (
      (currentCode === 0x2f || currentCode === 0x5c) &&
      text[index - 1] === "~"
    ) {
      if (!spend(budget, stats, 1, "scan")) break;
      index += 1;
      continue;
    }
    const explicitAt = currentCode === 0x40;
    if (explicitAt) {
      const scanned = scanAtReference(text, index, budget, stats, resolve);
      if (scanned.exhausted) break;
      if (scanned.candidate) candidates.push(scanned.candidate);
      index = Math.max(scanned.end, index + 1);
      continue;
    }
    if (
      (tildePathStart || (isCandidateBoundary(text, index) && pathWordAt(text, index))) &&
      budget.fileCandidates < CHAT_LINK_SCAN_LIMITS.maxFileCandidates
    ) {
      const marker = tildePathStart
        ? { found: true, end: index, exhausted: false }
        : hasPathMarker(text, index, budget, stats);
      if (marker.exhausted) break;
      if (!marker.found && marker.end > index) {
        index = marker.end;
        continue;
      }
      if (marker.found) {
        budget.fileCandidates += 1;
        stats.fileCandidateCount += 1;
        const window = candidateWindowEnd(text, index, budget, stats);
        if (window.exhausted) break;
        const candidateText = text.slice(index, window.end);
        if (!spend(budget, stats, candidateText.length, "window")) break;

        FILE_SCAN_RE.lastIndex = 0;
        const match = FILE_SCAN_RE.exec(candidateText);
        if (match?.[0]) {
          const raw = match[0];
          const end = index + raw.length;
          const continuesBeyondWindow =
            window.truncated && end >= window.end &&
            pathWordAt(text, window.end);
          if (continuesBeyondWindow) {
            const overlong = overlongCandidateEnd(
              text,
              start,
              window.end,
              budget,
              stats,
            );
            if (overlong.exhausted) break;
            index = Math.max(overlong.end, window.end);
            continue;
          }
          const decision = disposition(raw, text, start, budget, stats);
          if (decision === "exhausted") break;
          if (decision === "retry") {
            const space = raw.indexOf(" ");
            index = space >= 0 ? start + space + 1 : end;
            continue;
          }
          if (decision === "skip") {
            index = end;
            continue;
          }
          const target = resolve(raw);
          if (target) {
            candidates.push({ start, end, raw, target });
            budget.links += 1;
            stats.linkCount += 1;
            index = end;
          } else {
            index = end;
          }
          continue;
        }

        if (window.truncated) {
          const overlong = overlongCandidateEnd(
            text,
            start,
            window.end,
            budget,
            stats,
          );
          if (overlong.exhausted) break;
          index = Math.max(overlong.end, window.end);
          continue;
        }
        if (tildePathStart) {
          index = Math.max(window.end, index + 1);
          continue;
        }
      }
    }

    const width = codePointWidth(text, index);
    if (!spend(budget, stats, width, "scan")) break;
    index += width;
  }
  finishDiagnostic({
    workCodeUnits: stats.workCodeUnits,
    linkCount: stats.linkCount,
    reason: budget.links >= CHAT_LINK_SCAN_LIMITS.maxLinks
      ? "link-limit"
      : budget.workCodeUnits >= CHAT_LINK_SCAN_LIMITS.maxScanWorkCodeUnits
        ? "scan-budget"
        : undefined,
  });
  return { candidates, stats };
}

const PATH_WORD = String.raw`[\p{L}\p{N}_@+.-]+`;
const PATH_SEGMENT = String.raw`[\p{L}\p{N}_@+. -]+`;
const PATH_CONTINUATION = String.raw`[\p{L}\p{N}_@+.-]*[\\/]`;
const FILE_END = String.raw`\.[A-Za-z0-9]{1,8}(?:[+@-][\p{L}\p{N}_@+-]*)?(?::\d+(?::\d+|-\d+)?|#[lL]\d+(?:-[lL]?\d+)?)?(?![A-Za-z0-9_@+-]|\.[A-Za-z0-9]|${PATH_CONTINUATION})`;
const BARE_FILE_END = String.raw`(?:${[...KNOWN_BARE_CHAT_FILES].join("|")})(?![\p{L}\p{N}_@+.-]|${PATH_CONTINUATION})`;
const FILE_NAME = String.raw`(?:${PATH_SEGMENT}?${FILE_END}|${BARE_FILE_END})`;
const UNC_PREFIX = String.raw`(?:\\\\[^\\/\s]+[\\/]|\/\/[^/\s]+\/)`;
const SPACED_START = String.raw`(?<![\p{L}\p{N}_@+.-])[A-Za-z][\p{L}\p{N}_+-]*(?: [\p{L}\p{N}_+-]+)+`;
const FILE_SCAN_SOURCE = [
  String.raw`@"[^"\n]+"`,
  String.raw`@[^\s]+`,
  String.raw`(?:[A-Za-z]:[\\/]|${UNC_PREFIX}|\/)(?:${PATH_SEGMENT}[\\/])*?${FILE_NAME}`,
  String.raw`${SPACED_START}[\\/](?:${PATH_SEGMENT}[\\/])*?${FILE_NAME}`,
  String.raw`${SPACED_START}(?:\.[A-Za-z0-9_-]+)*${FILE_END}`,
  String.raw`(?:${PATH_WORD}[\\/])+(?:${PATH_SEGMENT}[\\/])*?${FILE_NAME}`,
  String.raw`(?:~[\\/])?\/?\.{1,2}[\\/](?:${PATH_WORD}\/)*${PATH_WORD}(?::\d+(?::\d+|-\d+)?|#[lL]\d+(?:-[lL]?\d+)?)?`,
  String.raw`(?:~[\\/])?\/?(?:${PATH_WORD}\/)+${PATH_WORD}(?::\d+(?::\d+|-\d+)?|#[lL]\d+(?:-[lL]?\d+)?)?`,
  String.raw`[\p{L}\p{N}_@+-][\p{L}\p{N}_@+.-]*${FILE_END}`,
].join("|");
const FILE_SCAN_RE = new RegExp(FILE_SCAN_SOURCE, "uy");
