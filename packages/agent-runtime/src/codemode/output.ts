/**
 * Model-facing result of one codemode script: a status header, the script's
 * own output in production order, and on failure a summary of which nested
 * calls already completed. Side effects are never described as rolled back.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { CodemodeOutputItem, CodemodeResult } from "@earendil-works/pi-codemode";
import { CODEMODE_CHARS_PER_TOKEN } from "./limits.js";
import type { NestedCallRecord } from "./nested-calls.js";

type Item = TextContent | ImageContent;

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * With more than one text item each starts with a `==> text N/M <==` line,
 * because providers join adjacent text blocks without a separator. Console
 * lines follow the rest in one `<console_output>` block.
 */
function layout(output: readonly CodemodeOutputItem[]): Item[] {
  const total = output.filter((item) => item.type === "text" && !item.console).length;
  const items: Item[] = [];
  const consoleLines: string[] = [];
  let index = 0;
  for (const item of output) {
    if (item.type === "image") {
      items.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else if (item.console) {
      consoleLines.push(item.text);
    } else {
      index += 1;
      items.push({ type: "text", text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text });
    }
  }
  if (consoleLines.length > 0) {
    items.push({ type: "text", text: `<console_output>\n${consoleLines.join("\n")}\n</console_output>` });
  }
  return items;
}

function joinText(items: readonly Item[]): Item[] {
  const joined: Item[] = [];
  let parts: string[] = [];
  const flush = () => {
    if (parts.length) joined.push({ type: "text", text: parts.join("\n") });
    parts = [];
  };
  for (const item of items) {
    if (item.type === "text") {
      parts.push(item.text);
    } else {
      flush();
      joined.push(item);
    }
  }
  flush();
  return joined;
}

/** Keep the start and end of over-budget text; images follow it unchanged. */
function truncate(items: readonly Item[], maxTokens: number): { items: Item[]; truncated: boolean } {
  const texts = items.filter((item): item is TextContent => item.type === "text").map((item) => item.text);
  const combined = texts.join("\n");
  const budget = maxTokens * CODEMODE_CHARS_PER_TOKEN;
  if (texts.length === 0 || combined.length <= budget) return { items: [...items], truncated: false };
  const head = Math.floor(budget / 2);
  const tail = budget - head;
  const removed = combined.length - head - tail;
  const text = `Warning: output truncated (about ${Math.ceil(combined.length / CODEMODE_CHARS_PER_TOKEN)} tokens; budget ${maxTokens}). Filter or summarize inside the script, or raise max_output_tokens.\n\n${combined.slice(0, head)}\n…${Math.ceil(removed / CODEMODE_CHARS_PER_TOKEN)} tokens truncated…\n${combined.slice(combined.length - tail)}`;
  return {
    items: [{ type: "text", text }, ...items.filter((item) => item.type === "image")],
    truncated: true,
  };
}

function callSummary(calls: readonly NestedCallRecord[]): string {
  if (calls.length === 0) return "No nested calls were made.";
  return `Nested calls made before the failure (completed side effects are not undone): ${calls
    .map((call) => `${call.name} (${call.status})`)
    .join(", ")}`;
}

function errorHead(result: Extract<CodemodeResult, { ok: false }>): string {
  const { error } = result;
  switch (error.kind) {
    case "script":
      return error.stack ?? `${error.name ?? "Error"}: ${error.message}`;
    case "timeout":
      return `Script timed out: ${error.message}`;
    case "aborted":
      return `Script aborted: ${error.message}`;
    default:
      return `Script sandbox failed: ${error.message}`;
  }
}

export function formatScriptResult(
  result: CodemodeResult,
  calls: readonly NestedCallRecord[],
  maxOutputTokens: number,
  wallMs: number,
): { content: Item[]; truncated: boolean } {
  const output = [...result.output];
  if (result.ok && result.value !== undefined) output.push({ type: "text", text: valueText(result.value) });
  const items = layout(output);
  if (!result.ok) items.push({ type: "text", text: `Script error:\n${errorHead(result)}\n\n${callSummary(calls)}` });
  const bounded = truncate(joinText(items), maxOutputTokens);
  const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${(wallMs / 1000).toFixed(1)} seconds\nOutput:\n`;
  return { content: joinText([{ type: "text", text: header }, ...bounded.items]), truncated: bounded.truncated };
}

/** A script that never started: no nested call ran, so nothing needs undoing. */
export function formatNotStarted(reason: string, wallMs: number): Item[] {
  return [{
    type: "text",
    text: `Script failed\nWall time ${(wallMs / 1000).toFixed(1)} seconds\nOutput:\nScript error:\n${reason}\n\nThe script did not start.`,
  }];
}
