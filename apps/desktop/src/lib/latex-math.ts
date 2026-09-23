type MdastLike = {
  type?: string;
  value?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  data?: Record<string, unknown>;
  children?: MdastLike[];
};

/** Convert TeX-style delimiters to remark-math's equal-width dollar syntax. */
export function normalizeLatexMathDelimiters(source: string): string {
  const output = source.split("");
  let offset = 0;
  let codeTicks = 0;
  let fence: { char: "`" | "~"; length: number } | null = null;
  let math: { close: ")" | "]"; open: number } | null = null;

  const isDelimiter = (index: number, bracket: string) => {
    if (source[index] !== "\\" || source[index + 1] !== bracket) return false;
    let precedingSlashes = 0;
    for (let i = index - 1; i >= 0 && source[i] === "\\"; i--) precedingSlashes++;
    return precedingSlashes % 2 === 0;
  };

  for (const line of source.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue;
    const body = line.endsWith("\n") ? line.slice(0, -1) : line;
    const fenceMatch = !codeTicks && !math
      ? /^( {0,3})(`{3,}|~{3,})(.*?)(?:\r)?$/.exec(body)
      : null;
    if (fence) {
      if (
        fenceMatch?.[2]?.[0] === fence.char &&
        fenceMatch[2].length >= fence.length &&
        !fenceMatch[3]?.trim()
      ) {
        fence = null;
      }
      offset += line.length;
      continue;
    }
    if (fenceMatch) {
      fence = {
        char: fenceMatch[2][0] as "`" | "~",
        length: fenceMatch[2].length,
      };
      offset += line.length;
      continue;
    }

    for (let i = 0; i < line.length;) {
      const index = offset + i;
      if (math) {
        if (isDelimiter(index, math.close)) {
          output[math.open] = output[math.open + 1] = "$";
          output[index] = output[index + 1] = "$";
          // Retain the historical single-line bracket representation and
          // source offsets. Dollar-fenced math bypasses this normalization
          // and preserves its newlines; block splitting must use the math
          // grammar rather than relying on flattened input.
          for (let j = math.open + 2; j < index; j++) {
            if (output[j] === "\n") output[j] = " ";
          }
          math = null;
          i += 2;
        } else {
          i++;
        }
        continue;
      }

      if (line[i] === "`") {
        let length = 1;
        while (line[i + length] === "`") length++;
        if (!codeTicks) codeTicks = length;
        else if (codeTicks === length) codeTicks = 0;
        i += length;
        continue;
      }
      if (codeTicks) {
        i++;
        continue;
      }
      if (isDelimiter(index, "(") || isDelimiter(index, "[")) {
        math = {
          close: source[index + 1] === "(" ? ")" : "]",
          open: index,
        };
        i += 2;
        continue;
      }
      i++;
    }
    offset += line.length;
  }

  return output.join("");
}

/** Preserve TeX bracket display semantics after remark-math parses `$$…$$`. */
export function remarkLatexBracketDisplay(source: string) {
  return function latexBracketDisplay() {
    return (tree: MdastLike) => {
      const visit = (node: MdastLike) => {
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (
          node.type === "inlineMath" &&
          typeof start === "number" &&
          typeof end === "number" &&
          source.slice(start, start + 2) === "\\[" &&
          source.slice(end - 2, end) === "\\]"
        ) {
          node.data = {
            ...node.data,
            hProperties: { className: ["language-math", "math-display"] },
          };
        }
        node.children?.forEach(visit);
      };
      visit(tree);
    };
  };
}
