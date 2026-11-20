/** Responses adapters encode the item ID and optional phase in textSignature. */
export function responsesTextPhase(signature: unknown): "commentary" | "final_answer" | undefined {
  if (typeof signature !== "string" || !signature.startsWith("{")) return undefined;
  try {
    const item = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown } | null;
    if (item?.v === 1 && typeof item.id === "string" && item.id &&
        (item.phase === "commentary" || item.phase === "final_answer")) return item.phase;
  } catch {
    // Other providers use opaque signatures, including non-JSON strings.
  }
}

export function isResponsesCommentary(signature: unknown): boolean {
  return responsesTextPhase(signature) === "commentary";
}
