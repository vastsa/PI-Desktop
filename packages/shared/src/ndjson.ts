/** The readable-stream surface needed by the stdio transport (no Node imports). */
interface NdjsonInput {
  setEncoding(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
}

/**
 * Read LF-delimited JSON text, accepting CRLF and a final unterminated frame.
 * Unlike readline, Unicode line/paragraph separators are ordinary payload.
 * The input owns UTF-8 decoding, including characters split across byte chunks.
 */
export type NdjsonLineReader = { close: () => void };

type NdjsonOptions = {
  /** Maximum length in UTF-16 units, excluding LF. */
  maxFrameLength?: number;
  /** Called once per dropped frame with at most 256 leading code units. */
  onOversizedFrame?: (prefix: string) => void;
};

export function readNdjsonLines(
  input: NdjsonInput,
  onLine: (line: string) => void,
  options: NdjsonOptions = {},
): NdjsonLineReader {
  const maxFrameLength = options.maxFrameLength ?? Infinity;
  let closed = false;
  let fragments: string[] = [];
  let length = 0;
  let oversizedPrefix: string | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    fragments = [];
    oversizedPrefix = undefined;
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", close);
  };
  const append = (fragment: string) => {
    if (oversizedPrefix !== undefined || fragment.length === 0) return;
    if (length + fragment.length > maxFrameLength) {
      // Copy only the response header, then drain through LF without retaining
      // any more chunks from this frame.
      let prefix = "";
      for (const piece of [...fragments.slice(0, 256), fragment]) {
        prefix += piece.slice(0, 256 - prefix.length);
        if (prefix.length === 256) break;
      }
      fragments = [];
      oversizedPrefix = prefix;
      return;
    }
    fragments.push(fragment);
    length += fragment.length;
  };
  const emit = () => {
    const complete = fragments;
    const prefix = oversizedPrefix;
    fragments = [];
    length = 0;
    oversizedPrefix = undefined;
    if (prefix !== undefined) {
      options.onOversizedFrame?.(prefix);
      return;
    }
    const line = complete.join("");
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  const onData = (chunk: string) => {
    let start = 0;
    while (!closed) {
      const end = chunk.indexOf("\n", start);
      append(chunk.slice(start, end === -1 ? undefined : end));
      if (end === -1) return;
      emit();
      start = end + 1;
    }
  };
  const onEnd = () => {
    try {
      if (!closed && (fragments.length > 0 || oversizedPrefix !== undefined)) emit();
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
