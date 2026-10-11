import { blockRendererLanguageKey } from "@pi-desktop/plugin-sdk";

/**
 * Pure helpers for the `blockRenderer` slot (`docs/plugin-plan/ui/block-renderer/`).
 *
 * The contract: a plugin claims the whole code block for a fence language
 * registered as `<pluginId>:lang`; the host hands `{ language, source }`
 * once when the fence closes (props-once), and the plugin owns the chrome.
 * The host keeps exactly one guarantee — a block taller than 4000px counts
 * as a render failure and falls back to the host code block.
 */

/** The one host-side clamp on a plugin-drawn block. */
export const BLOCK_RENDERER_MAX_HEIGHT_PX = 4000;

/** True when a block's drawn content exceeds the host clamp. */
export function blockRendererOverflow(contentHeight: number): boolean {
  return contentHeight > BLOCK_RENDERER_MAX_HEIGHT_PX;
}

/**
 * The registry key a fence language could hit, or `undefined` for a plain
 * one. Only a label with the `<pluginId>:` prefix shape can match a
 * registration, so `json`, `ts`, `mermaid`, … never touch the registry.
 */
export function blockRendererCandidate(lang: string): string | undefined {
  return lang.includes(":") ? blockRendererLanguageKey(lang) : undefined;
}

/** A run of a user message's text: plain, or a fence a plugin could claim. */
export type UserTextRun =
  | { kind: "text"; text: string; start: number }
  | {
      kind: "fence";
      /** The fence with the line breaks around it, as the message holds it. */
      raw: string;
      language: string;
      source: string;
      start: number;
    };

/**
 * A closed fence at a line start whose info string has the `<pluginId>:lang`
 * shape, closed by the same backtick run on a line of its own.
 */
const PLUGIN_FENCE = /(^|\n)(`{3,})([^\s`]+:[^\s`]*)[ \t]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g;

/**
 * User messages render as plain text, not Markdown, so a fence there stays
 * text unless a plugin claims its language. This finds the candidates: only
 * fences tagged in the `<pluginId>:lang` shape (`json`, `ts`, … never match),
 * each taking the line breaks around it so a drawn block does not leave blank
 * lines behind. Offsets are relative to `text`.
 */
export function splitPluginFences(text: string): UserTextRun[] {
  const runs: UserTextRun[] = [];
  let at = 0;
  for (const match of text.matchAll(PLUGIN_FENCE)) {
    const start = match.index;
    let end = start + match[0].length;
    if (text[end] === "\n") end++;
    if (start > at) runs.push({ kind: "text", text: text.slice(at, start), start: at });
    runs.push({
      kind: "fence",
      raw: text.slice(start, end),
      language: match[3],
      source: match[4],
      start,
    });
    at = end;
  }
  if (at < text.length || runs.length === 0) runs.push({ kind: "text", text: text.slice(at), start: at });
  return runs;
}
