/** Bounds for work performed synchronously while rendering transcript content. */
export const MAX_SYNC_MARKDOWN_CODE_UNITS = 128 * 1024;
export const MAX_STREAMING_MARKDOWN_TAIL_CODE_UNITS = 32 * 1024;
export const MAX_SMOOTH_TEXT_CODE_UNITS = 32 * 1024;
export const MAX_HIGHLIGHT_CODE_UNITS = 100_000;
export const MAX_HIGHLIGHT_LINES = 800;
export const MAX_HIGHLIGHT_LINE_CODE_UNITS = 2_000;
export const MAX_RENDERED_TEXT_PAGE_CODE_UNITS = 32 * 1024;

export type RenderedTextPage = {
  text: string;
  index: number;
  count: number;
};

/** Return one bounded, UTF-16-safe page from a potentially large output. */
export function renderedTextPage(
  source: string,
  requestedIndex: number,
  followLatest = false,
): RenderedTextPage {
  const count = Math.max(1, Math.ceil(source.length / MAX_RENDERED_TEXT_PAGE_CODE_UNITS));
  const index = followLatest
    ? count - 1
    : Math.max(
        0,
        Math.min(count - 1, Number.isNaN(requestedIndex) ? 0 : Math.floor(requestedIndex)),
      );
  const pageStart = index * MAX_RENDERED_TEXT_PAGE_CODE_UNITS;
  const pageEnd = Math.min(source.length, pageStart + MAX_RENDERED_TEXT_PAGE_CODE_UNITS);
  const startsWithLowSurrogate =
    pageStart > 0 &&
    pageStart < source.length &&
    isLowSurrogate(source.charCodeAt(pageStart)) &&
    isHighSurrogate(source.charCodeAt(pageStart - 1));
  const endsWithHighSurrogate =
    pageEnd < source.length &&
    isLowSurrogate(source.charCodeAt(pageEnd)) &&
    isHighSurrogate(source.charCodeAt(pageEnd - 1));
  const start = pageStart + Number(startsWithLowSurrogate);
  const end = pageEnd + Number(endsWithHighSurrogate);
  return { text: source.slice(start, end), index, count };
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

export type HighlightLimitInspection = {
  within: boolean;
  lineCount: number;
  longestLine: number;
  reason?: "code-length" | "line-count" | "line-length";
};

/** Cheap raw-source guard; call before splitting, parsing, or normalizing code. */
export function inspectHighlightLimits(source: string): HighlightLimitInspection {
  if (source.length > MAX_HIGHLIGHT_CODE_UNITS) {
    return { within: false, lineCount: 0, longestLine: 0, reason: "code-length" };
  }

  let lineCount = 1;
  let lineLength = 0;
  let longestLine = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 0x0a) {
      longestLine = Math.max(longestLine, lineLength);
      lineCount += 1;
      if (lineCount > MAX_HIGHLIGHT_LINES) {
        return { within: false, lineCount, longestLine, reason: "line-count" };
      }
      lineLength = 0;
    } else {
      lineLength += 1;
      if (lineLength > MAX_HIGHLIGHT_LINE_CODE_UNITS) {
        return {
          within: false,
          lineCount,
          longestLine: Math.max(longestLine, lineLength),
          reason: "line-length",
        };
      }
    }
  }
  return {
    within: true,
    lineCount,
    longestLine: Math.max(longestLine, lineLength),
  };
}

export function isWithinHighlightLimits(source: string): boolean {
  return inspectHighlightLimits(source).within;
}
