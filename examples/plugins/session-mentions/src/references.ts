import type { ReferenceIdentity } from "./types.js";
import { stripSessionReferencePrompt } from "./prompt.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_PATTERN = new RegExp(`^${UUID}$`, "i");

export function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return ID_PATTERN.test(id) ? id.toLowerCase() : null;
}

/** Keeps PR #447's typed references and literal @session:UUID spelling. */
export function collectSessionReferenceIds(
  content: string,
  references: readonly ReferenceIdentity[] = [],
  excludeSessionId?: string | null,
): string[] {
  const ids = new Set<string>();
  const excluded = excludeSessionId ? normalizeSessionId(excludeSessionId) : null;
  const add = (value: string) => {
    const id = normalizeSessionId(value);
    if (id && id !== excluded) ids.add(id);
  };
  for (const reference of references) {
    if (reference.kind === "session") add(reference.path);
  }
  // Reject a longer/malformed identifier with a UUID-looking prefix.
  const pattern = new RegExp(`@session:(${UUID})(?![a-z0-9_-])`, "gi");
  for (const match of stripSessionReferencePrompt(content).matchAll(pattern)) {
    if (match[1]) add(match[1]);
  }
  return [...ids];
}
