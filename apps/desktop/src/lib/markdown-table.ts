/** The sanitized HAST subset used by the Markdown table renderer. */
export interface TableNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: TableNode[];
}

function rowsOf(node: TableNode): TableNode[] {
  return (node.children ?? []).flatMap((child) =>
    child.tagName === "tr" ? [child]
      : ["thead", "tbody", "tfoot"].includes(child.tagName ?? "") ? rowsOf(child) : [],
  );
}

function findMathSource(node: TableNode): string | undefined {
  if (node.tagName === "annotation") return (node.children ?? []).map(cellText).join("");
  for (const child of node.children ?? []) {
    const source = findMathSource(child);
    if (source !== undefined) return source;
  }
}

function cellText(node: TableNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "br") return "\n";
  if (node.tagName === "img") return String(node.properties?.alt ?? "");
  if (["script", "style"].includes(node.tagName ?? "")) return "";
  // KaTeX emits both MathML and a visual tree. Export the formula once.
  if (Array.isArray(node.properties?.className) && node.properties.className.includes("katex")) {
    return findMathSource(node) ?? "";
  }
  return (node.children ?? []).map(cellText).join("");
}

function csvCell(value: string): string {
  // Spreadsheet applications may execute formula-leading values even in quotes.
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value);
  const safe = !numeric && (/^\s*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value))
    ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Export one table, without reading unrelated tables or duplicating UI labels. */
export function markdownTableData(node: TableNode, originalSource: string) {
  const tableStart = node.position?.start.offset;
  const htmlTable = tableStart !== undefined && /^<table\b/i.test(originalSource.slice(tableStart));
  const rows = rowsOf(node);
  const cells = rows.map((row) => (row.children ?? []).filter((cell) =>
    cell.tagName === "th" || cell.tagName === "td",
  ));
  const textRows = cells.map((row) => row.map(cellText));
  const markdownRows = rows.map((row, index) => {
    const start = row.position?.start.offset;
    const end = row.position?.end.offset;
    const source = start !== undefined && end !== undefined
      ? originalSource.slice(start, end).trim() : "";
    // Parser row slices omit blockquote/list indentation. Keep inline Markdown
    // and escaped pipes intact; raw HTML tables fall back to plain-text cells.
    if (source && !htmlTable) return source;
    return `| ${textRows[index].map((text) => text.replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")).join(" | ")} |`;
  });
  const divider = `| ${(cells[0] ?? []).map((cell) => {
    const align = cell.properties?.align;
    return align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---";
  }).join(" | ")} |`;
  return {
    markdown: markdownRows.length ? [markdownRows[0], divider, ...markdownRows.slice(1)].join("\n") : "",
    csv: `\uFEFF${textRows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`,
  };
}
