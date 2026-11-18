import type { ChatContextChip } from "./chat-context-chips";

const OPEN = "<quoted-context>\n";
const CLOSE = "\n</quoted-context>";

export type ChatContextPart =
  | { kind: "text"; text: string; start: number; end: number }
  | { kind: "context"; chips: ChatContextChip[]; start: number; end: number };

/** Keep panel snapshots in the message itself so history and retries retain them. */
export function serializeChatContextChips(chips: readonly ChatContextChip[]): string {
  if (!chips.length) return "";
  const payload = JSON.stringify({
    version: 1,
    items: chips.map(({ title, content }) => ({ title, content })),
  }).replace(/</g, "\\u003c");
  return `${OPEN}${payload}${CLOSE}`;
}

/** Only complete, recognized envelopes collapse; malformed text stays visible. */
export function splitChatContextContent(text: string): ChatContextPart[] {
  const parts: ChatContextPart[] = [];
  let cursor = 0;
  let search = 0;
  while (search < text.length) {
    const start = text.indexOf(OPEN, search);
    if (start < 0) break;
    const close = text.indexOf(CLOSE, start + OPEN.length);
    if (close < 0) break;
    const bodyStart = start + OPEN.length;
    search = close + CLOSE.length;
    let payload: unknown;
    try {
      payload = JSON.parse(text.slice(bodyStart, close));
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object" || !("version" in payload) || payload.version !== 1 ||
      !("items" in payload) || !Array.isArray(payload.items) || !payload.items.length ||
      !payload.items.every((item: unknown) => item && typeof item === "object" &&
        "title" in item && typeof item.title === "string" && item.title.trim() &&
        "content" in item && typeof item.content === "string" && item.content.trim())) continue;
    let end = close + CLOSE.length;
    if (text.startsWith("\n\n", end)) end += 2;
    if (start > cursor) parts.push({ kind: "text", text: text.slice(cursor, start), start: cursor, end: start });
    parts.push({
      kind: "context", start, end,
      chips: payload.items.map((item: { title: string; content: string }, index: number) => ({
        id: `context-${start}-${index}`, title: item.title, content: item.content,
      })),
    });
    cursor = search = end;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor), start: cursor, end: text.length });
  return parts;
}

export function chatContextPlainText(text: string): string {
  return splitChatContextContent(text).map((part) => part.kind === "text"
    ? part.text
    : `${part.chips.map((chip) => chip.content).join("\n\n")}\n\n`).join("");
}
