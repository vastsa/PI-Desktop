/** Small file-type glyphs shared by review headings and turn summaries. */
export function ReviewFileIcon({ path }: { path: string }) {
  const extension = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
  const kind = /^(md|mdx|markdown)$/.test(extension) ? "markdown"
    : /^(json|jsonc|json5)$/.test(extension) ? "json"
    : /^(py|pyw)$/.test(extension) ? "python"
    : /^(ts|tsx|js|jsx|mjs|cjs|html|css|scss|less|vue|svelte|rs|go|java|c|h|cpp|sh|ps1|toml|yaml|yml)$/.test(extension) ? "code" : "document";
  return <span className={`review-file-type is-${kind}`} aria-hidden="true">
    <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      {kind === "markdown" ? <path d="M2 13V7l3 3 3-3v6M11 9v5m-2-2 2 2 2-2" strokeWidth="1.8" />
        : kind === "json" ? <path d="M7 3H5.5C4 3 4 4.5 4 6v1c0 2-2 2-2 3s2 1 2 3v1c0 1.5 0 3 1.5 3H7m6-14h1.5C16 3 16 4.5 16 6v1c0 2 2 2 2 3s-2 1-2 3v1c0 1.5 0 3-1.5 3H13" />
        : kind === "python" ? <><path d="M10 2c-4 0-4 1-4 4h5v1H4c-3 0-3 7 0 7h2v-3c0-2 1-3 3-3h4c2 0 3-1 3-3V4c0-2-2-2-6-2Z" fill="currentColor" stroke="none" /><path d="M10 18c4 0 4-1 4-4H9v-1h7c3 0 3-7 0-7h-1v3c0 2-1 3-3 3H8c-2 0-3 1-3 3v1c0 2 2 2 5 2Z" fill="currentColor" opacity=".65" stroke="none" /></>
        : kind === "code" ? <path d="m6 6-4 4 4 4m8-8 4 4-4 4m-3-9-2 10" />
        : <path d="M12 2.5v4h4M5 2.5h7l4 4V17H5zM7.5 10h6m-6 2.5h6m-6 2.5h4" />}
    </svg>
  </span>;
}
