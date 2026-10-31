import { useMemo } from "react";
import { splitGenUiReferences, type GenUiSplit } from "@pi-desktop/shared";

const EMPTY: GenUiSplit["references"] = [];

const REFERENCE_PREFIX = "::visualize";

/**
 * Drop a trailing line that is, or may still become, a `::visualize` reference
 * so a streaming reply never flashes the raw line and its absolute path. Only
 * the last non-blank line is considered: an earlier line is complete text.
 */
export function hideStreamingGenUiReference(content: string): string {
  const trimmedEnd = content.trimEnd();
  const lineStart = trimmedEnd.lastIndexOf("\n") + 1;
  const line = trimmedEnd.slice(lineStart).trim();
  if (!line) return content;
  const partial = line.startsWith(REFERENCE_PREFIX)
    ? line.length === REFERENCE_PREFIX.length || line[REFERENCE_PREFIX.length] === "{"
    : REFERENCE_PREFIX.startsWith(line);
  if (!partial) return content;
  return trimmedEnd.slice(0, lineStart).trimEnd();
}

/**
 * Visualization references are parsed only once a message is complete: a
 * streaming reply may still be writing the line (or its file), and a card that
 * appears mid-stream would flash an "unavailable" state. Until then a trailing
 * reference line is hidden.
 *
 * With inline visualizations switched off, the reference lines are still
 * stripped — a historical reply must not leak its absolute path as text — but
 * no card is produced, so nothing is loaded from disk.
 */
export function genUiSplitFor(content: string, streaming: boolean, enabled = true): GenUiSplit {
  if (streaming) return { content: hideStreamingGenUiReference(content), references: EMPTY };
  const split = splitGenUiReferences(content);
  return enabled ? split : { content: split.content, references: EMPTY };
}

export function useGenUiSplit(content: string, streaming: boolean, enabled = true): GenUiSplit {
  return useMemo(() => genUiSplitFor(content, streaming, enabled), [content, streaming, enabled]);
}
