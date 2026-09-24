import type { ComposerCommand } from "@pi-desktop/shared";

import type { ComposerCommandResolution } from "../../../hooks/use-composer-autocomplete";

/**
 * Slash submission dispatch for the composer (issue #795).
 *
 * Kept free of React and of the store so the decision can be tested on its own:
 * the only input is the typed text plus the command resolution the autocomplete
 * hook produced for it.
 */

/** A submission that starts with `/name`, split into its name and body. */
export type SlashSubmission = {
  name: string;
  body: string;
};

/**
 * Split a composer submission into a slash name and body, or `null` when the
 * text is not a slash submission at all — it does not start with `/`, or holds
 * nothing after the slash.
 */
export function parseSlashSubmission(content: string): SlashSubmission | null {
  if (!content.startsWith("/")) return null;
  const end = content.search(/\s/);
  const name = content.slice(1, end === -1 ? undefined : end);
  if (!name) return null;
  return { name, body: end === -1 ? "" : content.slice(end).trim() };
}

/**
 * What the composer does with one submission.
 *
 * `blocked` is the fail-closed branch: the command source could not be read, so
 * the composer cannot prove `/compact` is not a builtin and shows an error
 * instead of handing the text to the model.
 */
export type SlashDispatch =
  | { action: "dispatch"; command: ComposerCommand & { id: string }; body: string }
  | { action: "prompt" }
  | { action: "blocked"; error: Error };

/**
 * Decide the fate of one submission. Templates, unknown aliases, and
 * command entries without a dispatchable id keep the prompt path — that is
 * older behavior than the source-failure branch — while an unreadable source
 * blocks the submission so a control command is never degraded into prompt
 * text.
 */
export function resolveSlashDispatch(
  submission: SlashSubmission | null,
  resolution: ComposerCommandResolution | null,
): SlashDispatch {
  if (!submission || !resolution) return { action: "prompt" };
  if (resolution.status === "unavailable") {
    return { action: "blocked", error: resolution.error };
  }
  if (resolution.status === "unknown") return { action: "prompt" };
  const { command } = resolution;
  const { id } = command;
  if (command.kind === "template" || !id) return { action: "prompt" };
  return { action: "dispatch", command: { ...command, id }, body: submission.body };
}
