/**
 * Draft state for the external-agent section of the provider dialog.
 *
 * The rules live here rather than in the component so they can be tested
 * without a JSX runtime: `apps/desktop/test` imports TypeScript through
 * `node --test` hooks that strip types but do not compile JSX, and the consent
 * gate is exactly the kind of rule that must not be verified by clicking
 * through a dialog.
 *
 * One rule here is a security boundary, not a form nicety. An external agent
 * is a program on this machine that runs with the project folder as its
 * working directory and edits that folder with its own tools. It does not ask
 * the host, so the host cannot allow or deny any of it — see
 * `docs/adr/0287-external-acp-agents.md`. Making the user acknowledge that
 * before the row is saved is the only control the host actually has.
 */

/** Known agents offered as one-click fills. */
export const ACP_PRESETS = [
  { id: "opencode", label: "OpenCode", command: "opencode", args: "acp" },
] as const;

export type AcpAgentConfigLike = { command: string; args: string[]; modelId?: string };

export type AcpDraft = {
  enabled: boolean;
  command: string;
  args: string;
  modelId: string;
  /**
   * Whether the user has acknowledged this command's filesystem access.
   *
   * Deliberately not persisted. It lives for one dialog session, so consent is
   * re-given whenever the row is edited rather than being a flag that silently
   * outlives the decision it recorded.
   */
  acknowledged: boolean;
};

export function acpDraftFrom(provider?: { acp?: AcpAgentConfigLike } | null): AcpDraft {
  const acp = provider?.acp;
  return {
    enabled: Boolean(acp),
    command: acp?.command ?? "",
    args: (acp?.args ?? ["acp"]).join(" "),
    modelId: acp?.modelId ?? "",
    // Opening the dialog re-asks, even for a row that already has an agent.
    acknowledged: false,
  };
}

/** `acp --flag "two words"` → `["acp", "--flag", "two words"]`. */
export function parseArgs(input: string): string[] {
  const out: string[] = [];
  const rx = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(input))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export type AcpDraftProblem = "emptyCommand" | "consentRequired";

export function validateAcpDraft(draft: AcpDraft): AcpDraftProblem | null {
  if (!draft.enabled) return null;
  if (draft.command.trim() === "") return "emptyCommand";
  // Last, so the message is about the command rather than the tick box while
  // the command is still mid-typing.
  if (!draft.acknowledged) return "consentRequired";
  return null;
}

/**
 * Apply an edit to the draft.
 *
 * A patch that changes the command drops the acknowledgement: consent was
 * given for one program, not for whatever lands in the field afterwards.
 * Everything else — arguments, model, the tick box itself — keeps it.
 */
export function acpDraftEdited(draft: AcpDraft, patch: Partial<AcpDraft>): AcpDraft {
  const next = { ...draft, ...patch };
  if (patch.command !== undefined && patch.command !== draft.command) {
    return { ...next, acknowledged: false };
  }
  return next;
}

/**
 * The config a draft saves, or null when there is nothing to save.
 *
 * Refuses an unacknowledged draft rather than only reporting it: this is the
 * single funnel from the dialog to a persisted `config_json.acp`, so a caller
 * that ignores `validateAcpDraft` still cannot persist an agent the user was
 * never told about.
 */
export function acpConfigFrom(draft: AcpDraft): AcpAgentConfigLike | null {
  if (!draft.enabled) return null;
  if (validateAcpDraft(draft) !== null) return null;
  const modelId = draft.modelId.trim();
  return {
    command: draft.command.trim(),
    args: parseArgs(draft.args),
    ...(modelId ? { modelId } : {}),
  };
}
