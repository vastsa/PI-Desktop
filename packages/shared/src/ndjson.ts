/** The readable-stream surface needed by the stdio transport (no Node imports). */
interface NdjsonInput {
  setEncoding(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
}

export const DEFAULT_NDJSON_MAX_LINE_BYTES = 64 * 1024 * 1024;
const BLOCK_CODE_UNITS = 4096;
const ERROR_PREFIX_CODE_UNITS = 2048;

export type NdjsonLineReader = { close: () => void };
export type NdjsonFrameError = {
  kind: "limit" | "assembly";
  /** Bounded, potentially sensitive frame prefix for correlation only. */
  prefix: string;
  /** UTF-8 bytes seen at detection, including LF if seen. */
  observedBytes: number;
  limitBytes: number;
  error: Error;
};

type NdjsonOptions = {
  /** UTF-8 byte limit including any CR and LF delimiters. */
  maxLineBytes?: number;
  onFrameError?: (error: NdjsonFrameError) => void;
};

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

// Count without encoding or allocating a second copy of the text. If a
// surrogate pair straddles chunks, the high surrogate has already counted 3.
function utf8Bytes(text: string, afterHighSurrogate: boolean): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (afterHighSurrogate && code >= 0xdc00 && code <= 0xdfff) bytes++;
    else bytes += 3;
    afterHighSurrogate = isHighSurrogate(code);
  }
  return bytes;
}

function framePrefix(parts: Iterable<string>): string {
  const prefix: string[] = [];
  let remaining = ERROR_PREFIX_CODE_UNITS;
  for (const part of parts) {
    prefix.push(part.slice(0, remaining));
    remaining -= part.length;
    if (remaining <= 0) break;
  }
  // Detach the small preview from any large source string backing a slice.
  return Array.from(prefix.join("")).join("");
}

/**
 * Read LF-delimited JSON text, accepting CRLF and a final unterminated frame.
 * Unlike readline, Unicode line/paragraph separators are ordinary payload.
 * The input owns UTF-8 decoding, including characters split across byte chunks.
 */
export function readNdjsonLines(
  input: NdjsonInput,
  onLine: (line: string) => void,
  { maxLineBytes, onFrameError }: NdjsonOptions = {},
): NdjsonLineReader {
  if (maxLineBytes !== undefined && (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1 || maxLineBytes > DEFAULT_NDJSON_MAX_LINE_BYTES)) {
    throw new RangeError(`NDJSON line limit must be between 1 and ${DEFAULT_NDJSON_MAX_LINE_BYTES} bytes`);
  }
  // Callers opt into a byte cap together with their own request-error mapping.
  // Importers and other existing readers retain lossless, uncapped framing.
  const limitBytes = maxLineBytes ?? Number.POSITIVE_INFINITY;
  const reportFrameError = (failure: NdjsonFrameError) => {
    if (!onFrameError) throw failure.error;
    onFrameError(failure);
  };
  let closed = false;
  let discarding = false;
  let blocks: string[] = [];
  let fragments: string[] = [];
  let fragmentUnits = 0;
  let bufferedBytes = 0;
  let afterHighSurrogate = false;

  const resetFrame = () => {
    blocks = [];
    fragments = [];
    fragmentUnits = 0;
    bufferedBytes = 0;
    afterHighSurrogate = false;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    discarding = false;
    resetFrame();
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", close);
  };
  const buffer = (part: string) => {
    if (!part) return;
    // Bound the reference count even if every incoming chunk is a single byte.
    if (part.length >= BLOCK_CODE_UNITS || fragmentUnits + part.length >= BLOCK_CODE_UNITS) {
      if (fragments.length) blocks.push(fragments.join(""));
      fragments = [];
      fragmentUnits = 0;
    }
    if (part.length >= BLOCK_CODE_UNITS) {
      blocks.push(part);
    } else {
      fragments.push(part);
      fragmentUnits += part.length;
    }
  };
  const accept = (part: string, hasLf: boolean, atEof = false) => {
    const observedBytes = bufferedBytes + utf8Bytes(part, afterHighSurrogate) + Number(hasLf);
    if (observedBytes > limitBytes) {
      const prefix = framePrefix([...blocks, ...fragments, part]);
      resetFrame();
      discarding = !hasLf;
      reportFrameError({
        kind: "limit", prefix, observedBytes, limitBytes,
        error: new RangeError("NDJSON line exceeds the byte limit"),
      });
      return;
    }
    if (!hasLf && !atEof) {
      bufferedBytes = observedBytes;
      if (part) afterHighSurrogate = isHighSurrogate(part.charCodeAt(part.length - 1));
      buffer(part);
      return;
    }
    const parts = [...blocks, ...fragments, part];
    resetFrame();
    let line: string;
    try {
      line = parts.join("");
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      reportFrameError({
        kind: "assembly", prefix: framePrefix(parts), observedBytes, limitBytes, error,
      });
      return;
    }
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  const onData = (chunk: string) => {
    let start = 0;
    while (!closed && start < chunk.length) {
      const end = chunk.indexOf("\n", start);
      if (discarding) {
        if (end === -1) return;
        discarding = false;
      } else if (end === -1) {
        accept(chunk.slice(start), false);
        return;
      } else {
        accept(chunk.slice(start, end), true);
      }
      start = end + 1;
    }
  };
  const onEnd = () => {
    try {
      if (!closed && !discarding && bufferedBytes > 0) accept("", false, true);
    } finally {
      close();
    }
  };
  input.setEncoding("utf8");
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", close);
  return { close };
}
