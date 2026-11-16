/**
 * Model-visible content blocks for a persisted tool result.
 *
 * The parent session restore (`toolResultFromUi` in `runtime.ts`) and a
 * delegate `Task(resume)` rebuild (`delegation-history.ts`) must apply the
 * same rules. One helper keeps a resumed subagent from flattening image
 * bytes into JSON text or dropping MCP resource bodies.
 */

import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { isRecord } from "./agent-messages.js";

/**
 * Model-visible text for one host tool content block. Besides plain `text`
 * blocks, MCP servers return file bodies as embedded text resources and large
 * payloads as resource links (github-mcp-server `get_file_contents` sends a
 * status line plus one of these), so dropping them next to a sibling text
 * block hides the actual result from the model. Binary resources and other
 * block kinds have no text to show and stay out of the text channel.
 */
export function hostContentBlockText(block: unknown): string | undefined {
  if (!isRecord(block)) return undefined;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (
    block.type === "resource" &&
    isRecord(block.resource) &&
    typeof block.resource.text === "string"
  ) {
    return block.resource.text;
  }
  if (block.type === "resource_link" && typeof block.uri === "string") {
    const name = typeof block.name === "string" && block.name.trim()
      ? `${block.name.trim()}: `
      : "";
    return `[resource link] ${name}${block.uri}`;
  }
  return undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function appendContentBlocks(
  blocks: ToolResultMessage["content"],
  entries: readonly unknown[],
): void {
  for (const block of entries) {
    if (!isRecord(block)) continue;
    const blockText = hostContentBlockText(block);
    if (blockText !== undefined) {
      blocks.push({ type: "text", text: blockText });
    } else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
}

/**
 * Content blocks for a persisted tool result. Does not insert the
 * missing-result placeholder; each caller keeps its own placeholder, details,
 * and error rules.
 *
 * Covers `raw.content`, a bare content-block array (#1360), a plain string,
 * and a host Read image file's top-level `images` array (#1073). Image `data`
 * stays on image blocks. Anything else present becomes JSON text.
 */
export function restoredToolResultContent(
  raw: unknown,
): ToolResultMessage["content"] {
  const blocks: ToolResultMessage["content"] = [];
  const rawBlocks =
    isRecord(raw) && Array.isArray(raw.content) ? raw.content : undefined;
  if (rawBlocks) {
    appendContentBlocks(blocks, rawBlocks);
  } else if (Array.isArray(raw)) {
    appendContentBlocks(blocks, raw);
  } else if (typeof raw === "string" && raw.trim()) {
    blocks.push({ type: "text", text: raw });
  } else if (raw !== undefined && raw !== null) {
    const rawObject = isRecord(raw) ? raw : undefined;
    const images = rawObject?.images;
    if (rawObject && Array.isArray(images)) {
      const rest = { ...rawObject };
      delete rest.images;
      blocks.push({ type: "text", text: safeJson(rest) });
      for (const image of images) {
        if (
          isRecord(image) &&
          typeof image.data === "string" &&
          typeof image.mimeType === "string"
        ) {
          blocks.push({
            type: "image",
            data: image.data,
            mimeType: image.mimeType,
          });
        }
      }
    } else {
      blocks.push({ type: "text", text: safeJson(raw) });
    }
  }
  return blocks;
}
