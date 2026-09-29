import { isSessionThinkingLevel } from "@pi-desktop/shared";

/**
 * A separate, strictly bounded plugin operation; never forward an arbitrary
 * session config. The optional thinking level is the only additional field a
 * preauthorized call may carry — session mode and permission mode stay on the
 * dangerous `session/configure` path, and the host validates the same shape.
 */
export type SessionModelChange = {
  id: string;
  providerId: string;
  modelId: string;
  thinkingLevel?: string;
};

const SELECTION_FIELDS: readonly string[] = ["providerId", "modelId", "thinkingLevel"];

export function parseSessionModelChange(args: readonly unknown[]): SessionModelChange {
  const invalid = () => Object.assign(
    new Error(
      "session model change requires id and permits providerId, modelId and thinkingLevel only",
    ),
    { code: "INVALID_PARAMS" },
  );
  if (args.length !== 2 || typeof args[0] !== "string" || !args[0].trim()) throw invalid();
  const selection = args[1];
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw invalid();
  const fields = Object.keys(selection);
  if (!fields.includes("providerId") || !fields.includes("modelId")) throw invalid();
  if (fields.some((field) => !SELECTION_FIELDS.includes(field))) throw invalid();
  const { providerId, modelId, thinkingLevel } = selection as Record<string, unknown>;
  if (typeof providerId !== "string" || !providerId.trim() ||
      typeof modelId !== "string" || !modelId.trim()) throw invalid();
  if (thinkingLevel === undefined) return { id: args[0], providerId, modelId };
  if (!isSessionThinkingLevel(thinkingLevel)) throw invalid();
  return { id: args[0], providerId, modelId, thinkingLevel };
}
