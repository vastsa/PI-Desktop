import type { Model, Api } from "@earendil-works/pi-ai";

export type CompactionRequestShape = {
  api: string;
  topLevelFields: string[];
  roleCounts: Record<string, number>;
  toolCount: number;
  outputLimit: number | "omitted";
};

const MAX_FIELDS = 32;
const FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

function outputLimit(payload: Record<string, unknown>): number | "omitted" {
  for (const key of ["max_output_tokens", "max_tokens", "max_tokens_to_sample"]) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return "omitted";
}
export function compactionRequestShape(input: {
  model: Model<Api>;
  payload: unknown;
  messages: readonly { role?: unknown }[];
  tools?: readonly unknown[];
}): CompactionRequestShape {
  const payloadRecord =
    input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
      ? (input.payload as Record<string, unknown>)
      : {};
  const roleCounts: Record<string, number> = {};
  for (const message of input.messages) {
    if (typeof message.role !== "string") continue;
    roleCounts[message.role] = (roleCounts[message.role] ?? 0) + 1;
  }
  return {
    api: input.model.api,
    topLevelFields: Object.keys(payloadRecord)
      .filter((field) => FIELD_RE.test(field))
      .slice(0, MAX_FIELDS),
    roleCounts,
    toolCount: input.tools?.length ?? 0,
    outputLimit: outputLimit(payloadRecord),
  };
}
