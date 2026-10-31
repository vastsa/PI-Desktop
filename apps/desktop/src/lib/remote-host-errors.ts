/** Only approved localized summaries cross into remote-host UI; never raw stderr. */
export function remoteHostErrorKey(error: unknown): string {
  let code: unknown;
  if (error && typeof error === "object") {
    code = "errorCode" in error ? error.errorCode : "code" in error ? error.code : undefined;
  }
  switch (code) {
    case "REMOTE_PATH_NOT_FOUND": return "remote:pathUnavailable";
    case "REMOTE_PATH_FORBIDDEN": return "remote:pathForbidden";
    case "HOST_VERSION_MISMATCH": return "remote:upgradeRequired";
    case "HOST_BOOTSTRAP_FAILED": return "remote:hostBootstrapFailed";
    case "HOST_AUTH_FAILED":
    case "SSH_AUTH_FAILED":
    case "TOKEN_INVALID":
    case "PAIRING_FAILED": return "remote:authenticationRequired";
    case "HOST_DISCONNECTED":
    case "REMOTE_CONNECTION_FAILED":
    case "AGENT_UNAVAILABLE": return "remote:connectionUnavailable";
    case "REMOTE_MUTATION_OUTCOME_UNKNOWN": return "remote:mutationUncertain";
    default: return "remote:operationFailed";
  }
}
