import { randomUUID } from "node:crypto";

const PICKER_TOKEN_TTL_MS = 60_000;
const MAX_PENDING_PICKER_SELECTIONS = 32;
const PICKER_TOKEN_RE = /^[0-9a-f-]{36}$/i;

type PendingPickerSelection = {
  paths: string[];
  senderId: number;
  expiresAt: number;
};

const pendingSelections = new Map<string, PendingPickerSelection>();

function pruneExpired(now: number) {
  for (const [token, selection] of pendingSelections) {
    if (selection.expiresAt <= now) pendingSelections.delete(token);
  }
}

/**
 * Keep native picker paths in Electron main. The renderer receives only a
 * short-lived, sender-bound capability for the next import call.
 */
export function rememberComposerPickerSelection(
  paths: string[],
  senderId: number,
  now = Date.now(),
): string {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("picker selection is empty");
  }
  pruneExpired(now);
  while (pendingSelections.size >= MAX_PENDING_PICKER_SELECTIONS) {
    const oldest = pendingSelections.keys().next().value as string | undefined;
    if (!oldest) break;
    pendingSelections.delete(oldest);
  }

  const token = randomUUID();
  pendingSelections.set(token, {
    paths: [...paths],
    senderId,
    expiresAt: now + PICKER_TOKEN_TTL_MS,
  });
  return token;
}

/**
 * Consume the one-shot capability. Raw paths are never accepted from the
 * renderer, and a token cannot be replayed or used by another WebContents.
 */
export function consumeComposerPickerSelection(
  token: unknown,
  senderId: number,
  now = Date.now(),
): string[] {
  pruneExpired(now);
  if (typeof token !== "string" || !PICKER_TOKEN_RE.test(token)) {
    throw new Error("picker selection token is invalid");
  }
  const selection = pendingSelections.get(token);
  pendingSelections.delete(token);
  if (
    !selection ||
    selection.expiresAt <= now ||
    selection.senderId !== senderId
  ) {
    throw new Error("picker selection is unavailable");
  }
  return [...selection.paths];
}
