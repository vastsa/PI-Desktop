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
export function readNdjsonLines(input: NdjsonInput, onLine: (line: string) => void) {
  let closed = false;
  let fragments: string[] = [];
  const close = () => {
    if (closed) return;
    closed = true;
    fragments = [];
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", close);
  };
  const emit = (tail: string) => {
    fragments.push(tail);
    const line = fragments.join("");
    fragments = [];
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  const onData = (chunk: string) => {
    let start = 0;
    while (!closed) {
      const end = chunk.indexOf("\n", start);
      if (end === -1) {
        if (start < chunk.length) fragments.push(chunk.slice(start));
        return;
      }
      emit(chunk.slice(start, end));
      start = end + 1;
    }
  };
  const onEnd = () => {
    try {
      if (!closed && fragments.length > 0) emit("");
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
