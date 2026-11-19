/** Responses adapters encode the item ID and optional phase in textSignature. */
export function isResponsesCommentary(signature: unknown): boolean {
  if (typeof signature !== "string" || !signature.startsWith("{")) return false;
  try {
    const item = JSON.parse(signature) as { v?: unknown; id?: unknown; phase?: unknown } | null;
    return item?.v === 1 && typeof item.id === "string" && item.phase === "commentary";
  } catch {
    return false;
  }
}
