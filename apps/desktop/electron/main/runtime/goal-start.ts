/** Validate explicit user intent, never runtime origin or tool authority. */
export function goalStartRequested(request: {
  startGoal?: unknown;
  content: unknown;
  sessionMessageId?: unknown;
}): boolean {
  if ((request.startGoal !== undefined && typeof request.startGoal !== "boolean") ||
    (request.startGoal === true && (typeof request.content !== "string" ||
      !request.content.trim() || Buffer.byteLength(request.content, "utf8") > 100_000 || request.sessionMessageId !== undefined))) {
    throw Object.assign(new Error("Invalid Goal startup input"), { errorCode: "INVALID_ARGUMENT" });
  }
  return request.startGoal === true;
}

/** A queued ordinary prompt cannot become a Goal because input preferences changed. */
export function goalPromptMode(sessionMode: string, startGoal: boolean | undefined): string {
  if (startGoal === true) return "goal";
  return startGoal === false && sessionMode === "goal" ? "agent" : sessionMode;
}
