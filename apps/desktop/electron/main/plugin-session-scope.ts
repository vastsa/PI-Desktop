/**
 * Scope rules for plugin session events (#1754). Selection events carry
 * another project's session identity, so their recipients are scope-checked
 * against the announced session's project — the same line `session.getActive`
 * enforces on the pull side. Kept dependency free so
 * `plugin-services.test.mjs` can drive the filter directly.
 */

/** Session events whose payload describes the user's current selection. */
export const SESSION_SCOPED_EVENTS = new Set(["session:activated"]);

/**
 * The recipient filter for a session event, or `undefined` when the event
 * fans out unconditionally.
 */
export function sessionEventScopeFilter(
  event: string,
  sessionId: string | undefined,
  sessionProjects: ReadonlyMap<string, string | null>,
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean,
): ((pluginId: string) => boolean) | undefined {
  if (!SESSION_SCOPED_EVENTS.has(event)) return undefined;
  return (pluginId: string) =>
    pluginActiveInProject(
      pluginId,
      (sessionId && sessionProjects.get(sessionId)) ?? null,
    );
}
