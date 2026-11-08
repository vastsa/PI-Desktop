/** Mode service boundary for pre-existing Agent/Plan IPC fixtures.
 * Staged-mode dispatch is covered by mode-runs-main.test.mjs.
 */
export const builtinModeRuns = {
  async definitionForPrompt(id) {
    if (id !== "agent" && id !== "plan") throw new Error(`Unsupported fixture mode: ${id}`);
    return undefined;
  },
  async canContinue() { return false; },
  async prepareTurn({ sessionMode }) {
    if (sessionMode !== "agent" && sessionMode !== "plan") {
      throw new Error(`Unsupported fixture mode: ${sessionMode}`);
    }
    return undefined;
  },
  async abandonTurn() {},
};
