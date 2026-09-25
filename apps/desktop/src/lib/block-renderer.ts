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
