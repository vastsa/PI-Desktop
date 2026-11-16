/** Bound for a provider-reported model id shown in the transcript. */
const MAX_RESPONSE_MODEL_LENGTH = 200;

/** A dated snapshot of the requested id (`gpt-4o-2024-08-06`, `claude-x-20250101`). */
const DATED_SNAPSHOT_SUFFIX = /^-\d{4}-?\d{2}-?\d{2}$/;

/**
 * The concrete model a provider reports serving a response (Pi 1.5
 * `AssistantMessage.responseModel`), kept only when it tells the user
 * something the requested id does not: a router, virtual, or fallback model
 * that resolved to a different model. The value is provider-controlled text,
 * so it is bounded and must be printable.
 */
export function concreteResponseModel(
  message: { responseModel?: unknown },
  requestedModelId: string,
): string | undefined {
  const raw = message.responseModel;
  if (typeof raw !== "string") return undefined;
  const responseModel = raw.trim();
  if (!responseModel || responseModel.length > MAX_RESPONSE_MODEL_LENGTH) return undefined;
  // Control characters (C0, DEL, C1) never belong in a model id.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(responseModel)) return undefined;
  if (responseModel === requestedModelId) return undefined;
  if (
    responseModel.startsWith(requestedModelId) &&
    DATED_SNAPSHOT_SUFFIX.test(responseModel.slice(requestedModelId.length))
  ) {
    return undefined;
  }
  return responseModel;
}
