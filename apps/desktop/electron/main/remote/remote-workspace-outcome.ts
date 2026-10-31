/** A lost reply cannot prove whether a side effect reached the remote filesystem. */
export function workspaceExecutionError(toolName: string, error: unknown): unknown {
  if (!["Write", "Edit", "Bash"].includes(toolName)) return error;
  const code = error && typeof error === "object"
    ? "errorCode" in error ? error.errorCode : "code" in error ? error.code : undefined
    : undefined;
  if (!["HOST_DISCONNECTED", "TIMEOUT", "AGENT_UNAVAILABLE", "REMOTE_CONNECTION_FAILED"].includes(String(code))) return error;
  return Object.assign(new Error("Remote mutation outcome is unknown after the connection was interrupted. Inspect the remote files before retrying; this call was not replayed."), {
    errorCode: "REMOTE_MUTATION_OUTCOME_UNKNOWN", retriable: false,
  });
}
