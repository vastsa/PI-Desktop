/**
 * Which execution backend runs a session, for the UI to say so.
 *
 * A session whose provider carries an `acp` block is not run by the built-in
 * agent. Its turns go to a program on this machine that brings its own models
 * and credentials, and that program edits the project folder with its own
 * tools. The host does not see or mediate those edits (ADR 0287), so the
 * access model is stated again at the point where a prompt is about to be
 * sent rather than only in Settings.
 *
 * The lookup is a pure function over what the store already holds: a session's
 * `providerId` and the provider list. It needs no IPC, and it is separated
 * from the component so the rule is testable without a JSX runtime.
 */

/** The part of a provider row that decides the backend. */
export type SessionBackendProvider = {
  id: string;
  acp?: { command?: string } | null;
};

export type SessionBackend = {
  /** The program that runs this session's turns, e.g. `opencode`. */
  command: string;
};

/**
 * The external agent running a session, or null when the built-in agent runs
 * it.
 *
 * A provider row is cleared of its agent by an empty command rather than by
 * removing the block, because serde maps both to "absent" — so an empty
 * command is a row without an agent, not one with a broken one.
 */
export function externalAgentForSession(
  providerId: string | undefined,
  providers: readonly SessionBackendProvider[],
): SessionBackend | null {
  if (!providerId) return null;
  const provider = providers.find((candidate) => candidate.id === providerId);
  const command = provider?.acp?.command?.trim();
  if (!command) return null;
  return { command };
}
