import type { ClassifiedAgentError } from "./agent-errors.js";
import { ErrorCodes } from "@pi-desktop/shared";

/** Recognize literal call-shaped output, never turn assistant prose into actions. */
export function textToolCallDiagnostic(
  text: string,
  toolNames: ReadonlyMap<string, unknown>,
): ClassifiedAgentError | undefined {
  let fence: { marker: string; length: number } | undefined;
  const visible: string[] = [];
  for (const line of text.split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const marker = delimiter[1][0];
      if (!fence) fence = { marker, length: delimiter[1].length };
      else if (marker === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      visible.push("");
    } else {
      visible.push(fence ? "" : line);
    }
  }
  const prose = visible.join("\n");
  const starts = /(?:^|\n) {0,3}<tool_call>/g;
  let coveredUntil = 0;
  for (const start of prose.matchAll(starts)) {
    if (start.index < coveredUntil) continue;
    const offset = start.index + start[0].length;
    const end = prose.indexOf("</tool_call>", offset);
    if (end < 0) break;
    coveredUntil = end + "</tool_call>".length;
    const body = prose.slice(offset, end);
    const call = /^\s*<function=([\w.-]{1,128})>\s*<parameter=[\w.-]{1,128}>/.exec(body);
    if (!call || !toolNames.has(call[1]) || !/<\/parameter>\s*<\/function>\s*$/.test(body)) continue;
    return {
      code: ErrorCodes.TOOL_CALL_NOT_EXECUTED,
      message: `The reply contains a text-form ${call[1]} call. Text is not executed as a tool call; check the provider's tool-call format and activate on-demand tools with ToolSearch.`,
      retriable: false,
    };
  }
  return undefined;
}
